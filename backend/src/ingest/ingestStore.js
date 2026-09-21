import { query } from '../db/pool.js';
import { ingestConfig, CHUNKER_VERSION, PARSER_VERSION } from './config.js';
import { chunkUid } from './ids.js';

// All ingestion SQL lives here so the service stays about *flow*, not queries.
// Every write is idempotent (ON CONFLICT upsert) so a crashed run can be retried.

export async function ensureBook({ slug, title, author }) {
  const { rows } = await query(
    `INSERT INTO books (slug, title, author)
     VALUES ($1, COALESCE(NULLIF($2,''), 'Untitled'), $3)
     ON CONFLICT (slug) DO UPDATE
       SET title  = COALESCE(NULLIF(EXCLUDED.title,''),  books.title),
           author = COALESCE(EXCLUDED.author, books.author)
     RETURNING id, slug, title, author`,
    [slug, title || '', author || null]
  );
  return rows[0];
}

export async function ensureEdition({ bookId, label, language }) {
  const { rows } = await query(
    `INSERT INTO book_editions (book_id, label, language)
     VALUES ($1, $2, $3)
     ON CONFLICT (book_id, label) DO UPDATE
       SET language = COALESCE(EXCLUDED.language, book_editions.language)
     RETURNING id, book_id, label`,
    [bookId, label, language || null]
  );
  return rows[0];
}

export async function upsertSource({
  editionId,
  storageBackend,
  storageKey,
  originalFilename,
  mimeType,
  byteSize,
  sha256,
}) {
  const { rows } = await query(
    `INSERT INTO book_sources
       (edition_id, storage_backend, storage_key, original_filename, mime_type, byte_size, sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (edition_id) DO UPDATE
       SET storage_backend=EXCLUDED.storage_backend, storage_key=EXCLUDED.storage_key,
           original_filename=EXCLUDED.original_filename, mime_type=EXCLUDED.mime_type,
           byte_size=EXCLUDED.byte_size, sha256=EXCLUDED.sha256, updated_at=now()
     RETURNING id, edition_id, ingestion_status, sha256 AS existing_sha256`,
    [editionId, storageBackend, storageKey, originalFilename, mimeType, byteSize, sha256]
  );
  return rows[0];
}

export async function setStatus(sourceId, status, extra = {}) {
  const sets = ['ingestion_status = $2', 'updated_at = now()'];
  const params = [sourceId, status];
  const push = (col, val) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (extra.error !== undefined) push('ingestion_error', extra.error);
  if (extra.jobId !== undefined) push('ingest_job_id', extra.jobId);
  if (extra.startedAt) push('started_at', extra.startedAt);
  if (extra.completedAt) push('completed_at', extra.completedAt);
  if (extra.pageCount !== undefined) push('page_count', extra.pageCount);
  if (extra.parserVersion !== undefined) push('parser_version', extra.parserVersion);
  if (extra.embeddingModel !== undefined) push('embedding_model', extra.embeddingModel);
  if (extra.embeddingDim !== undefined) push('embedding_dim', extra.embeddingDim);
  if (extra.pdfMetadata !== undefined) push('pdf_metadata', JSON.stringify(extra.pdfMetadata));
  await query(
    `UPDATE book_sources SET ${sets.join(', ')} WHERE id = $1`,
    params
  );
}

// Idempotency guard: a COMPLETED source for this edition with the same hash is a no-op.
export async function findCompletedSource({ editionId, sha256 }) {
  const { rows } = await query(
    `SELECT id, page_count FROM book_sources
      WHERE edition_id = $1 AND sha256 = $2 AND ingestion_status = 'COMPLETED'
      LIMIT 1`,
    [editionId, sha256]
  );
  return rows[0] || null;
}

export async function deleteDerived(sourceId) {
  // On a (re)build we clear stale pages/chunks for THIS source only.
  await query(`DELETE FROM literature_chunks WHERE book_source_id = $1`, [sourceId]);
  await query(`DELETE FROM book_pages WHERE book_source_id = $1`, [sourceId]);
}

export function toVectorLiteral(vec) {
  for (const x of vec) {
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error('EMBEDDING_NAN');
  }
  return `[${vec.join(',')}]`;
}

const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Insert pages in batches; returns Map(pageNumber -> pageId).
export async function insertPages(sourceId, editionId, pages) {
  const ids = new Map();
  for (const batch of chunk(pages, ingestConfig.dbWriteBatchSize)) {
    const values = [];
    const params = [];
    let p = 0;
    for (const pg of batch) {
      params.push(
        sourceId,
        editionId,
        pg.pageNumber,
        pg.width ?? null,
        pg.height ?? null,
        pg.rotation ?? null,
        pg.rawText ?? '',
        pg.normalizedText ?? '',
        pg.rawText ? pg.rawText.length : 0,
        pg.items ? JSON.stringify(pg.items) : null,
        pg.coordinatesAvailable ?? false
      );
      const b = p; p += 11;
      values.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10}::jsonb,$${b + 11})`
      );
    }
    const { rows } = await query(
      `INSERT INTO book_pages
        (book_source_id, edition_id, page_number, page_width, page_height, rotation,
         raw_text, normalized_text, char_count, text_items, coordinates_available)
       VALUES ${values.join(',')}
       ON CONFLICT (book_source_id, page_number) DO UPDATE SET
         raw_text=EXCLUDED.raw_text, normalized_text=EXCLUDED.normalized_text,
         text_items=EXCLUDED.text_items, coordinates_available=EXCLUDED.coordinates_available
       RETURNING id, page_number`,
      params
    );
    for (const r of rows) ids.set(r.page_number, r.id);
  }
  return ids;
}

// Insert chunks (embedding may be null when the provider is unavailable — the
// caller decides whether that is allowed; here we simply persist what we're given).
export async function insertChunks({ sourceId, bookId, editionId, pageIds, chunks, vectors }) {
  let inserted = 0;
  const rowsData = chunks.map((c, i) => ({ c, vec: vectors ? vectors[i] : null }));
  for (const batch of chunk(rowsData, ingestConfig.dbWriteBatchSize)) {
    const values = [];
    const params = [];
    let p = 0;
    for (const { c, vec } of batch) {
      const uid = chunkUid({
        sourceId,
        chunkerVersion: CHUNKER_VERSION,
        chunkIndex: c.chunkIndex,
        pageNumber: c.pageNumber,
        sourceText: c.sourceText,
      });
      params.push(
        uid,
        bookId,
        editionId,
        sourceId,
        pageIds.get(c.pageNumber) ?? null,
        c.pageNumber,
        c.pageStart,
        c.pageEnd,
        c.chapter ?? null,
        c.chunkIndex,
        c.sourceText,
        c.searchText,
        JSON.stringify(c.spans ?? []),
        c.coordinatesAvailable ?? false,
        c.charCount ?? c.sourceText.length,
        c.tokenCount ?? 0,
        CHUNKER_VERSION,
        vec ? toVectorLiteral(vec) : null
      );
      const b = p; p += 18;
      values.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},
          $${b + 11},$${b + 12},$${b + 13}::jsonb,$${b + 14},$${b + 15},$${b + 16},$${b + 17},$${b + 18}::vector)`
      );
    }
    const res = await query(
      `INSERT INTO literature_chunks
        (chunk_uid, book_id, edition_id, book_source_id, page_id, page_number, page_start, page_end,
         chapter, chunk_index, source_text, search_text, spans, coordinates_available,
         char_count, token_count, chunker_version, embedding)
       VALUES ${values.join(',')}
       ON CONFLICT (chunk_uid) DO UPDATE SET
         embedding = COALESCE(EXCLUDED.embedding, literature_chunks.embedding),
         source_text = EXCLUDED.source_text, search_text = EXCLUDED.search_text,
         spans = EXCLUDED.spans, char_count = EXCLUDED.char_count, token_count = EXCLUDED.token_count`,
      params
    );
    inserted += res.rowCount ?? batch.length;
  }
  return inserted;
}

// Create the vector index only after real embeddings exist (Phase 2 §14).
export async function ensureVectorIndex(dim) {
  await query(
    `CREATE INDEX IF NOT EXISTS literature_chunks_embedding_idx
       ON literature_chunks USING hnsw (embedding vector_cosine_ops)`
  );
  return dim;
}

export { PARSER_VERSION, CHUNKER_VERSION };
