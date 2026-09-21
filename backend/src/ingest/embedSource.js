import { getPool } from '../db/pool.js';
import { env } from '../config/env.js';
import { ingestConfig } from './config.js';
import { toVectorLiteral } from './ingestStore.js';
import {
  makeEmbeddingProvider,
  probeDimension,
  validateVectors,
  EmbeddingError,
} from './embeddingProvider.js';

// Resumable, source-scoped embedding backfill (EMBEDDINGS + VECTOR RAG RECOVERY).
//
// Design guarantees (mirroring the task's safety rules):
//   * NEVER deletes/drops anything — it only UPDATEs embedding on rows that are
//     currently NULL (§2/§8). The 2281 chunks + provenance stay untouched.
//   * ONE provider health probe runs first; if it is unreachable the job stops
//     before touching the book and returns EMBEDDING_PROVIDER_UNAVAILABLE,
//     leaving the DB unchanged (§4/§37). No 2281 failing requests.
//   * The dimension is measured from a live probe and must equal the DB column
//     dimension; a mismatch stops with EMBEDDING_DIMENSION_MISMATCH and never
//     auto-migrates the schema (§12/§36).
//   * Work is batched with a per-batch transaction; a failed batch rolls back
//     while earlier committed batches remain, so a crash resumes from the rows
//     still NULL (§7/§13/§18). Memory stays bounded — it never loads all chunks.
//   * A PostgreSQL advisory lock makes a second job on the same source fail fast
//     with EMBEDDING_JOB_ALREADY_RUNNING (§14).
//
// The database is the checkpoint: the canonical condition is `embedding IS NULL`.
// This module runs only as an explicit CLI job — never on server boot (§29/§31).

class EmbedSourceError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

// Fixed advisory-lock "classid" so our locks never collide with other apps.
const LOCK_CLASSID = 61_520; // "BOOKMARK embeddings"

// Resolve the (book -> edition -> source) ownership chain from slug + label.
// Returns null if any link is missing (§9: never embed the wrong book).
async function resolveSource(client, { slug, edition }) {
  const { rows } = await client.query(
    `SELECT b.id AS book_id, be.id AS edition_id, bs.id AS source_id,
            bs.ingestion_status, bs.embedding_dim
       FROM books b
       JOIN book_editions be ON be.book_id = b.id
       JOIN book_sources   bs ON bs.edition_id = be.id
      WHERE b.slug = $1 AND be.label = $2
      LIMIT 1`,
    [slug, edition]
  );
  return rows[0] || null;
}

async function countsFor(client, sourceId) {
  const { rows } = await client.query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
            max(vector_dims(embedding)) AS live_dim
       FROM literature_chunks
      WHERE book_source_id = $1`,
    [sourceId]
  );
  return rows[0];
}

// Write one batch of (id -> vector) pairs inside a single transaction. Only
// rows that are STILL null are updated (idempotent + race-safe); the batch is
// committed only if every UPDATE succeeded, otherwise it rolls back whole.
async function writeBatch(client, pairs) {
  await client.query('BEGIN');
  try {
    for (const { id, vector } of pairs) {
      await client.query(
        `UPDATE literature_chunks SET embedding = $2::vector
          WHERE id = $1 AND embedding IS NULL`,
        [id, toVectorLiteral(vector)]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

export async function embedSource(opts = {}) {
  const {
    slug,
    edition,
    provider = makeEmbeddingProvider(),
    connect = async () => getPool().connect(),
    config = ingestConfig,
    expectedDim = env.embeddingDim,
    log = () => {},
  } = opts;

  if (!slug || !edition) throw new EmbedSourceError('EMBED_ARGS: --book and --edition are required');

  const client = await connect();
  let locked = false;
  try {
    // ---- §14 concurrency control: one job per source ----
    const lockRes = await client.query(
      `SELECT hashtext($1::text) AS key,
              pg_try_advisory_lock($2::int, hashtext($1::text)::int) AS acquired`,
      [`${slug}/${edition}`, LOCK_CLASSID]
    );
    if (!lockRes.rows[0]?.acquired) {
      throw new EmbedSourceError('EMBEDDING_JOB_ALREADY_RUNNING');
    }
    locked = true;

    // ---- §9 verify the exact source / book / edition chain ----
    const scope = await resolveSource(client, { slug, edition });
    if (!scope) throw new EmbedSourceError('SOURCE_NOT_FOUND', { slug, edition });
    if (scope.ingestion_status !== 'COMPLETED') {
      throw new EmbedSourceError('SOURCE_NOT_READY', { status: scope.ingestion_status });
    }
    const sourceId = scope.source_id;

    // ---- §4 probe the provider BEFORE processing anything ----
    let dim;
    try {
      dim = await probeDimension(provider);
    } catch (err) {
      // Unreachable / misconfigured provider: stop with a clear code, DB unchanged.
      const code =
        err instanceof EmbeddingError && err.code === 'EMBEDDING_NOT_CONFIGURED'
          ? 'EMBEDDING_NOT_CONFIGURED'
          : 'EMBEDDING_PROVIDER_UNAVAILABLE';
      throw new EmbedSourceError(code, { reason: err.code || err.message });
    }

    // ---- §12/§36 dimension must match the DB column; never auto-migrate ----
    if (expectedDim && dim !== expectedDim) {
      throw new EmbedSourceError('EMBEDDING_DIMENSION_MISMATCH', {
        provider_dim: dim,
        configured_dim: expectedDim,
      });
    }
    if (scope.embedding_dim && scope.embedding_dim !== dim) {
      throw new EmbedSourceError('EMBEDDING_DIMENSION_MISMATCH', {
        provider_dim: dim,
        source_dim: scope.embedding_dim,
      });
    }

    // ---- §17 real progress from real DB counts ----
    let c = await countsFor(client, sourceId);
    const total = c.total;
    log(`Embedding source: ${slug}/${edition}`);
    log(`  provider dim=${dim} configured dim=${expectedDim ?? 'n/a'}`);
    log(`  Total chunks: ${total}`);
    log(`  Already embedded: ${c.embedded}`);
    log(`  Remaining: ${total - c.embedded}`);
    if (total === 0) throw new EmbedSourceError('SOURCE_HAS_NO_CHUNKS', { sourceId });
    if (c.live_dim && c.live_dim !== dim) {
      throw new EmbedSourceError('EMBEDDING_DIMENSION_MISMATCH', {
        provider_dim: dim,
        stored_dim: c.live_dim,
      });
    }
    if (c.embedded === total) {
      log('  All chunks already embedded — nothing to do.');
      return { sourceId, total, embedded: total, nullEmbeddings: 0, dim, ok: true, noop: true };
    }

    // ---- §7/§15/§18 batched, resumable, memory-bounded loop ----
    const batchSize = config.embeddingBatchSize || 32;
    let processed = 0;
    let batchNo = 0;
    // We always re-select the NEXT still-NULL rows, so an interruption resumes
    // with zero wasted work and a concurrent writer can never double-embed.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { rows } = await client.query(
        `SELECT id, search_text FROM literature_chunks
          WHERE book_source_id = $1 AND embedding IS NULL
          ORDER BY id
          LIMIT $2`,
        [sourceId, batchSize]
      );
      if (!rows.length) break;

      batchNo++;
      // §10 real embeddings only; §11 every vector validated before it lands.
      const raw = await provider.embedBatch(rows.map((r) => r.search_text));
      validateVectors(raw, dim);
      await writeBatch(client, rows.map((r, i) => ({ id: r.id, vector: raw[i] })));

      processed += rows.length;
      log(`  Batch ${batchNo}: ${c.embedded + processed}/${total}`);
      // Re-read truth (also catches external changes) — never trust the counter alone.
      c = await countsFor(client, sourceId);
    }

    // ---- §20 post-embedding validation against real DB values ----
    const final = await countsFor(client, sourceId);
    const done = final.embedded === final.total;
    if (provider.modelId) {
      await client.query(
        `UPDATE book_sources SET embedding_model=$2, embedding_dim=$3, updated_at=now()
          WHERE id=$1`,
        [sourceId, provider.modelId(), dim]
      );
    }
    log(`  Embedded: ${final.embedded}/${final.total}  NULL: ${final.total - final.embedded}`);
    return {
      sourceId,
      total: final.total,
      embedded: final.embedded,
      nullEmbeddings: final.total - final.embedded,
      dim: final.live_dim ?? dim,
      ok: done,
    };
  } finally {
    if (locked) {
      await client
        .query(`SELECT pg_advisory_unlock($2::int, hashtext($1::text)::int)`, [`${slug}/${edition}`, LOCK_CLASSID])
        .catch(() => {});
    }
    await client.release?.();
  }
}

export { EmbedSourceError };
