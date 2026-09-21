import { resolve } from 'node:path';
import { query } from '../db/pool.js';
import { env } from '../config/env.js';
import { makeStorageProvider, fileExists } from '../services/storageService.js';
import { validatePdfSignature, sha256File, extractPdf } from './pdfParser.js';
import { buildChunks } from './chunker.js';
import { makeEmbeddingProvider, probeDimension, embedInBatches } from './embeddingProvider.js';
import { PARSER_VERSION, CHUNKER_VERSION, ingestConfig } from './config.js';
import { jobId } from './ids.js';
import * as store from './ingestStore.js';

// BookIngestionService — orchestrates the pipeline in separated steps (Phase 2 §16).
// It is DB-backed and provider-backed; nothing here fabricates data. If a step
// cannot do real work it throws and the source is marked FAILED (retry-safe).

const STEPS = [
  'Validating PDF',
  'Calculating source hash',
  'Extracting pages',
  'Creating chunks',
  'Generating embeddings',
  'Writing pgvector records',
  'Validating ingestion',
  'Completed',
];

export async function ingestBook(opts) {
  const {
    slug,
    edition: editionLabel,
    file,
    title,
    author,
    language,
    provider = makeEmbeddingProvider(),
    skipEmbeddings = false,
    force = false,
    log = () => {},
  } = opts;

  if (!slug || !editionLabel || !file) throw new Error('INGEST_ARGS: --book, --edition and --file are required');

  const job = jobId();
  const step = (n, extra = '') => log(`[${n}/${STEPS.length}] ${STEPS[n - 1]}${extra ? ' — ' + extra : ''}`);
  const t0 = Date.now();
  const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

  const absPath = resolve(file);
  if (!(await fileExists(absPath))) throw new Error(`FILE_NOT_FOUND: ${file}`);

  // [1] Validate it really is a PDF (magic bytes, not the extension).
  step(1);
  await validatePdfSignature(absPath);

  // [2] Content hash.
  step(2);
  const sha256 = await sha256File(absPath);

  // Resolve book / edition / source records + storage placement.
  const book = await store.ensureBook({ slug, title, author });
  const edition = await store.ensureEdition({ bookId: book.id, label: editionLabel, language });
  const provider_ = makeStorageProvider();
  const storageKey = provider_.keyFor(slug, editionLabel);
  // Put the file into the managed store unless it already lives at that key.
  if (!(await provider_.exists(storageKey))) {
    await provider_.put(storageKey, absPath);
  }
  let source = await store.upsertSource({
    editionId: edition.id,
    storageBackend: provider_.name,
    storageKey,
    originalFilename: absPath.split(/[\\/]/).pop(),
    mimeType: 'application/pdf',
    byteSize: (await provider_.open(storageKey)).fileSize,
    sha256,
  });

  // Idempotency: identical hash already fully ingested => do nothing (Phase 2 §3).
  if (!force) {
    const done = await store.findCompletedSource({ editionId: edition.id, sha256 });
    if (done) {
      log(`Already ingested (sha256 ${sha256.slice(0, 12)}…). Skipping. Use --force to rebuild.`);
      return { skipped: true, sourceId: done.id, pageCount: done.page_count, sha256, jobId: job };
    }
  }

  await store.setStatus(source.id, 'PROCESSING', { jobId: job, startedAt: new Date(), error: null });

  try {
    // [3] Real page extraction: dimensions, rotation, text + coordinates.
    step(3);
    const parsed = await extractPdf(absPath);
    await store.setStatus(source.id, 'PROCESSING', {
      pageCount: parsed.pageCount,
      parserVersion: PARSER_VERSION,
      pdfMetadata: parsed.metadata,
    });
    log(`  parsed ${parsed.pages.length} of ${parsed.pageCount} pages (parser ${PARSER_VERSION})`);

    // [4] Document-aware chunks.
    step(4);
    const chunks = buildChunks(parsed.pages, ingestConfig);
    log(`  ${chunks.length} chunks (chunker ${CHUNKER_VERSION})`);

    // [5] Real embeddings — measure the model's ACTUAL dimension from its output.
    let vectors = null;
    let actualDim = null;
    if (!skipEmbeddings) {
      step(5);
      actualDim = await probeDimension(provider);
      if (env.embeddingDim && actualDim !== env.embeddingDim) {
        throw new Error(
          `EMBEDDING_DIM_MISMATCH: model returns ${actualDim} but EMBEDDING_DIM=${env.embeddingDim}. Set EMBEDDING_DIM=${actualDim} and re-run npm run migrate.`
        );
      }
      vectors = await embedInBatches(provider, chunks.map((c) => c.searchText), {
        expectedDim: actualDim,
        onBatch: ({ start, count, total }) => log(`  embedded ${Math.min(start + count, total)}/${total}`),
      });
    } else {
      log('  (embeddings skipped — structural dry run; chunks stored with NULL embedding)');
    }

    // [6] Persist pages, then chunks (with vectors), then build the vector index.
    step(6);
    const pageIds = await store.insertPages(source.id, edition.id, mapPages(parsed.pages));
    await store.insertChunks({ sourceId: source.id, bookId: book.id, editionId: edition.id, pageIds, chunks, vectors });

    if (!skipEmbeddings) {
      await store.ensureVectorIndex(actualDim);
      await store.setStatus(source.id, 'PROCESSING', {
        embeddingModel: provider.modelId(),
        embeddingDim: actualDim,
      });
    }

    // [7] Validation against real DB values (never the in-memory copy).
    step(7);
    const summary = await validateIngestion({ sourceId: source.id, parsed, chunks });

    // [8] Done.
    step(8, elapsed());
    await store.setStatus(source.id, 'COMPLETED', { completedAt: new Date(), error: null });

    return { jobId: job, sourceId: source.id, sha256, summary };
  } catch (err) {
    await store
      .setStatus(source.id, 'FAILED', { error: sanitizeError(err) })
      .catch(() => {});
    throw err;
  }
}

function mapPages(pages) {
  return pages.map((p) => ({
    pageNumber: p.pageNumber,
    width: p.width,
    height: p.height,
    rotation: p.rotation,
    rawText: p.rawText,
    normalizedText: p.normalizedText,
    items: p.items,
    coordinatesAvailable: p.coordinatesAvailable,
  }));
}

// Runs real queries and returns numbers straight from PostgreSQL.
export async function validateIngestion({ sourceId, parsed, chunks }) {
  const pagesRes = await query(`SELECT count(*)::int AS c FROM book_pages WHERE book_source_id = $1`, [sourceId]);
  const chunkRes = await query(`SELECT count(*)::int AS c FROM literature_chunks WHERE book_source_id = $1`, [sourceId]);
  const embeddedRes = await query(
    `SELECT count(*)::int AS c FROM literature_chunks WHERE book_source_id = $1 AND embedding IS NOT NULL`,
    [sourceId]
  );
  const coordRes = await query(
    `SELECT count(*)::int AS c FROM book_pages WHERE book_source_id = $1 AND coordinates_available`,
    [sourceId]
  );
  const dimRes = await query(
    `SELECT vector_dims(embedding) AS dim FROM literature_chunks
      WHERE book_source_id = $1 AND embedding IS NOT NULL LIMIT 1`,
    [sourceId]
  );
  return {
    pdfPages: parsed ? parsed.pageCount : null,
    dbPages: pagesRes.rows[0].c,
    chunksExpected: chunks ? chunks.length : null,
    dbChunks: chunkRes.rows[0].c,
    embeddedChunks: embeddedRes.rows[0].c,
    coordinatePages: coordRes.rows[0].c,
    embeddingDim: dimRes.rows[0]?.dim ?? null,
  };
}

// Strip anything resembling credentials before persisting/loggable error text.
function sanitizeError(err) {
  const msg = String(err?.message || err || 'unknown');
  return msg.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]').slice(0, 500);
}
