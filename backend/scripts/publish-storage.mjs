// Production provenance: publish the ALREADY-INDEXED book PDF into Supabase
// Storage and switch its source row to the supabase backend — but ONLY after
// the uploaded object's SHA-256 is confirmed to equal book_sources.sha256.
//
// This guarantees the displayed PDF and the indexed chunks/coordinates come
// from the exact same bytes (§7/§36): if the hash ever mismatches we refuse to
// flip the source and report SOURCE_VERSION_MISMATCH instead.
//
// Additive + reversible: it uploads a namespaced object and updates one source
// row. Nothing is deleted. It never prints secrets.
//
//   node scripts/publish-storage.mjs --slug brothers-karamazov --edition db-seeded
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getPool } from '../src/db/pool.js';
import { env } from '../src/config/env.js';
import { makeStorageProvider } from '../src/services/storageService.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const SLUG = arg('slug', 'brothers-karamazov');
const EDITION = arg('edition', 'db-seeded');
const DRY = process.argv.includes('--dry-run');

if (!env.supabaseUrl || !env.supabaseServiceRoleKey || !env.supabaseStorageBucket) {
  console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET must be set');
  process.exit(1);
}

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const local = resolve(env.storageLocalDir, SLUG, EDITION, 'source.pdf');

const src = await pool.query(
  `SELECT bs.id, bs.sha256, bs.byte_size, bs.storage_backend
     FROM book_sources bs
     JOIN book_editions be ON be.id = bs.edition_id
     JOIN books b ON b.id = be.book_id
    WHERE b.slug = $1 AND be.label = $2`,
  [SLUG, EDITION]
);
const row = src.rows[0];
if (!row) {
  console.error(`No source for ${SLUG}/${EDITION} — ingest it first.`);
  process.exit(1);
}

const provider = makeStorageProvider('supabase');
const key = provider.keyFor(SLUG, EDITION); // relative, forward-slash key
console.log(`target key: ${key}  (bucket: ${env.supabaseStorageBucket})`);
console.log(`local source: ${local}`);
console.log(`indexed sha256: ${row.sha256?.slice(0, 16)}…`);

if (DRY) {
  console.log('\n[dry-run] would upload + verify + switch source to supabase. No changes made.');
  await pool.end();
  process.exit(0);
}

// [1] Upload (x-upsert so re-runs are idempotent).
const put = await provider.put(key, local);
console.log(`uploaded ${put.byteSize} bytes`);

// [2] Re-download the stored object and hash the REAL bytes.
const opened = await provider.open(key);
const hash = createHash('sha256');
await new Promise((res, rej) => {
  opened.stream.on('data', (c) => hash.update(c));
  opened.stream.on('end', res);
  opened.stream.on('error', rej);
});
const actual = hash.digest('hex');
console.log(`stored   sha256: ${actual.slice(0, 16)}…`);

if (actual !== row.sha256) {
  console.error('\nSOURCE_VERSION_MISMATCH — refusing to switch backend.');
  console.error(`  indexed=${row.sha256}`);
  console.error(`  stored   =${actual}`);
  await pool.end();
  process.exit(2);
}

// [3] Verified identical → point the source at Supabase Storage.
await pool.query(
  `UPDATE book_sources SET storage_backend='supabase', storage_key=$2, updated_at=now() WHERE id=$1`,
  [row.id, key]
);
console.log(`\nOK — source ${row.id} now served from Supabase Storage (hash verified).`);
await pool.end();
process.exit(0);
