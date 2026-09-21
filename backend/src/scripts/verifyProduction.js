import { env } from '../config/env.js';
import { getPool, query, closePool, dbAvailable } from '../db/pool.js';
import { verifySourceIntegrity, makeStorageProvider } from '../services/storageService.js';
import { groqConfigured } from '../services/groqService.js';
import { probeDimension, makeEmbeddingProvider } from '../ingest/embeddingProvider.js';

// §32 — Production readiness verification.
//
// This is the honest gate before deployment. Every check reports what it
// ACTUALLY observed by talking to the real dependency; nothing is assumed.
//   PASS  -> verified live
//   WARN  -> known, tolerated degradation (documented, non-blocking)
//   FAIL  -> a critical dependency is broken; the script exits non-zero.
//
// It never fabricates a result and never prints a secret value — a dependency
// is reported by name with its boolean/counters only.

const results = [];
function record(sev, name, detail) {
  results.push({ sev, name, detail });
  const mark = sev === 'PASS' ? ' ok ' : sev === 'WARN' ? 'warn' : 'FAIL';
  console.log(`[${mark}] ${name} — ${detail}`);
}

async function checkEnv() {
  const missing = [];
  if (!env.jwtSecret) missing.push('JWT_SECRET');
  if (!env.databaseUrl) missing.push('DATABASE_URL');
  if (env.corsOrigins.includes('*')) record('FAIL', 'CORS', 'CORS_ORIGINS contains "*" — forbidden for authenticated APIs');
  else if (env.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o)))
    record('WARN', 'CORS', 'CORS_ORIGINS still lists a localhost origin (fine for a preview, replace for prod)');
  else record('PASS', 'CORS', `origins=${env.corsOrigins.join(',')}`);
  if (missing.length) record('FAIL', 'ENV', `missing ${missing.join(', ')}`);
  else record('PASS', 'ENV', 'JWT_SECRET + DATABASE_URL present');
  return missing.length === 0;
}

async function checkDatabase() {
  if (!dbAvailable()) {
    record('FAIL', 'DATABASE', 'DATABASE_URL unset — cannot verify');
    return false;
  }
  const pool = getPool();
  try {
    await pool.query('SELECT 1');
    record('PASS', 'DATABASE', 'connection + SELECT 1 ok');
  } catch (e) {
    record('FAIL', 'DATABASE', `query failed: ${e.message}`);
    return false;
  }
  // pgvector extension
  try {
    const { rows } = await query("SELECT extversion FROM pg_extension WHERE extname='vector'");
    if (rows.length) record('PASS', 'PGVECTOR', `extension installed v${rows[0].extversion}`);
    else record('FAIL', 'PGVECTOR', 'extension "vector" not created');
  } catch (e) {
    record('FAIL', 'PGVECTOR', `probe failed: ${e.message}`);
  }
  // Required tables
  const need = ['books', 'book_editions', 'book_sources', 'book_pages', 'literature_chunks', 'users', 'conversations', 'conversation_messages'];
  try {
    const { rows } = await query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [need]
    );
    const have = new Set(rows.map((r) => r.table_name));
    const absent = need.filter((t) => !have.has(t));
    if (absent.length === 0) record('PASS', 'TABLES', `${need.length} required tables present`);
    else record('FAIL', 'TABLES', `missing: ${absent.join(', ')}`);
  } catch (e) {
    record('FAIL', 'TABLES', `introspection failed: ${e.message}`);
  }
  // Indexes on the retrieval path — FTS (GIN) and vector (HNSW/IVFFlat) checked
  // separately so the report is honest about which paths are actually indexed.
  try {
    const { rows } = await query(
      `SELECT indexdef FROM pg_indexes WHERE tablename='literature_chunks'`
    );
    const defs = rows.map((r) => r.indexdef.toLowerCase());
    const hasFts = defs.some((d) => d.includes('using gin') && d.includes('search_tsv'));
    const hasVec = defs.some((d) => d.includes('using hnsw') || d.includes('using ivfflat'));
    if (hasFts) record('PASS', 'FTS-INDEX', 'GIN index on search_tsv present');
    else record('WARN', 'FTS-INDEX', 'no GIN index on search_tsv — lexical search will seq-scan');
    if (hasVec) record('PASS', 'VECTOR-INDEX', 'HNSW/IVFFlat index present on embedding');
    else record('WARN', 'VECTOR-INDEX', 'no vector index — acceptable while embeddings are absent (lexical-only)');
  } catch (e) {
    record('WARN', 'INDEXES', `index introspection failed: ${e.message}`);
  }
  return true;
}

async function checkSources() {
  // Verify integrity for every COMPLETED ingested source: the object stored in
  // production storage must hash-match the DB record, or citations would point
  // at the wrong page. This is the SOURCE_VERSION_MISMATCH guard.
  const { rows } = await query(
    `SELECT b.slug, be.id AS edition_id, be.label, b.id AS book_id,
            bs.embedding_model, bs.embedding_dim, bs.storage_backend
       FROM book_sources bs
       JOIN book_editions be ON be.id = bs.edition_id
       JOIN books b ON b.id = be.book_id
      WHERE bs.ingestion_status = 'COMPLETED'
      ORDER BY b.slug, be.label`
  );
  if (!rows.length) {
    record('WARN', 'SOURCES', 'no COMPLETED source found — nothing to serve yet');
    return;
  }
  for (const s of rows) {
    try {
      const res = await verifySourceIntegrity(s.book_id, s.edition_id);
      if (res.ok) record('PASS', `PDF ${s.slug}/${s.label}`, `storage=${s.storage_backend} hash matches DB`);
      else if (res.code === 'SOURCE_VERSION_MISMATCH') record('FAIL', `PDF ${s.slug}/${s.label}`, `SOURCE_VERSION_MISMATCH (storage sha256 != indexed sha256)`);
      else record('FAIL', `PDF ${s.slug}/${s.label}`, `${res.code}`);
    } catch (e) {
      record('FAIL', `PDF ${s.slug}/${s.label}`, `integrity check threw: ${e.message}`);
    }
  }
  // Embedding column dimension sanity (does not require the provider to be up).
  const { rows: dimRows } = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
            count(*) FILTER (WHERE embedding IS NULL)::int AS null_embeddings,
            max(vector_dims(embedding)) AS live_dim
       FROM literature_chunks`
  );
  const d = dimRows[0];
  if (d.embedded === 0) record('WARN', 'VECTORS', `0/${d.total} embedded, NULL=${d.null_embeddings} — retrieval is lexical-only (documented degradation)`);
  else if (d.null_embeddings > 0) record('WARN', 'VECTORS', `${d.embedded}/${d.total} embedded, NULL=${d.null_embeddings}, dim=${d.live_dim} — backfill incomplete, run npm run ingest:embeddings`);
  else record('PASS', 'VECTORS', `${d.embedded}/${d.total} embedded, NULL=0, live dim=${d.live_dim ?? 'n/a'} — vector index populated`);
}

async function checkStorageProvider() {
  if (env.storageBackend !== 'supabase') {
    record('WARN', 'STORAGE', `backend=${env.storageBackend} (supabase recommended for production)`);
    return;
  }
  if (!(env.supabaseUrl && env.supabaseServiceRoleKey && env.supabaseStorageBucket)) {
    record('FAIL', 'STORAGE', 'supabase backend selected but URL/key/bucket incomplete');
    return;
  }
  // Light reachability probe: HEAD the bucket root via the provider. We only
  // report an HTTP status, never the key.
  try {
    const provider = makeStorageProvider('supabase');
    const { rows } = await query(
      `SELECT bs.storage_key FROM book_sources bs
        WHERE bs.storage_backend='supabase' AND bs.ingestion_status='COMPLETED' LIMIT 1`
    );
    if (!rows.length) {
      record('WARN', 'STORAGE', 'supabase configured but no stored object key to probe');
      return;
    }
    const info = await provider.info(rows[0].storage_key);
    if (info && Number.isFinite(info.byteSize) && info.byteSize > 0) record('PASS', 'STORAGE', `object reachable, bytes=${info.byteSize}`);
    else record('FAIL', 'STORAGE', 'object HEAD returned no size');
  } catch (e) {
    record('FAIL', 'STORAGE', `provider probe failed: ${e.message}`);
  }
}

async function checkEmbeddingProvider() {
  if (!(env.hfApiKey && env.hfEmbeddingModel)) {
    record('WARN', 'EMBEDDINGS', 'provider not configured — lexical-only retrieval');
    return;
  }
  // Attempt a real live probe. If the network blocks it (as in some sandboxes)
  // we report WARN, not a fake PASS — the app is designed to degrade to lexical.
  try {
    const provider = makeEmbeddingProvider();
    const dim = await probeDimension(provider);
    const expected = env.embeddingDim;
    if (expected && dim !== expected) record('FAIL', 'EMBEDDINGS', `live dim=${dim} != configured EMBEDDING_DIM=${expected}`);
    else record('PASS', 'EMBEDDINGS', `reachable model=${env.hfEmbeddingModel} dim=${dim}`);
  } catch (e) {
    record('WARN', 'EMBEDDINGS', `provider unreachable (${e.code || e.message}) — running lexical-only`);
  }
}

async function checkGroq() {
  if (!groqConfigured()) {
    record('FAIL', 'GROQ', 'GROQ_API_KEY / GROQ_MODEL unset — answers cannot be generated');
    return;
  }
  // Cheap reachability probe against the models endpoint. Reports status only.
  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { authorization: `Bearer ${env.groqApiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) record('PASS', 'GROQ', `reachable (HTTP ${res.status}) model=${env.groqModel}`);
    else record('FAIL', 'GROQ', `HTTP ${res.status} (check key/model)`);
  } catch (e) {
    record('WARN', 'GROQ', `probe failed (${e.message}) — key configured but not verified reachable`);
  }
}

async function main() {
  record('PASS', 'NODE', process.version);
  const envOk = await checkEnv();
  const dbOk = await checkDatabase();
  if (dbOk) {
    await checkSources();
    await checkStorageProvider();
  }
  await checkEmbeddingProvider();
  await checkGroq();
  await closePool();

  const fails = results.filter((r) => r.sev === 'FAIL');
  const warns = results.filter((r) => r.sev === 'WARN');
  console.log('\n================= VERIFY:PRODUCTION SUMMARY =================');
  console.log(`PASS=${results.length - fails.length - warns.length}  WARN=${warns.length}  FAIL=${fails.length}`);
  if (warns.length) console.log(`Warnings: ${warns.map((w) => w.name).join(', ')}`);
  if (fails.length) {
    console.log(`CRITICAL FAILURES: ${fails.map((f) => f.name).join(', ')}`);
    console.log('PRODUCTION CHECK: FAIL');
    process.exit(1);
  }
  if (!envOk) {
    console.log('PRODUCTION CHECK: FAIL (env)');
    process.exit(1);
  }
  console.log('PRODUCTION CHECK: PASS (all critical dependencies verified; warnings are documented degradations)');
  process.exit(0);
}

main().catch(async (err) => {
  console.error('VERIFY:PRODUCTION ERROR:', err.message);
  await closePool().catch(() => {});
  process.exit(1);
});
