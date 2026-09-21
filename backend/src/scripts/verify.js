import { parseArgs } from 'node:util';
import { query, getPool } from '../db/pool.js';

// Proves the structured book exists in PostgreSQL WITHOUT reopening/parsing the
// PDF — exactly what the future RAG system will query (Phase 2 §23).

async function main() {
  const { values } = parseArgs({
    options: {
      book: { type: 'string', short: 'b' },
      edition: { type: 'string', short: 'e', default: 'default' },
    },
  });
  if (!values.book) {
    console.error('usage: npm run verify:book -- --book <slug> [--edition <label>]');
    process.exit(1);
  }
  if (!getPool()) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const book = await query(
    `SELECT b.id AS book_id, b.title, be.id AS edition_id, bs.id AS source_id,
            bs.sha256, bs.ingestion_status, bs.page_count, bs.embedding_model, bs.embedding_dim
       FROM books b
       JOIN book_editions be ON be.book_id = b.id
       JOIN book_sources bs ON bs.edition_id = be.id
      WHERE b.slug = $1 AND be.label = $2
      LIMIT 1`,
    [values.book, values.edition]
  );
  if (!book.rowCount) {
    console.log(`NOT FOUND: no ingested source for book="${values.book}" edition="${values.edition}".`);
    await getPool()?.end();
    process.exit(2);
  }
  const src = book.rows[0];
  const sourceId = src.source_id;

  const pages = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE coordinates_available)::int AS with_coords
       FROM book_pages WHERE book_source_id = $1`,
    [sourceId]
  );
  const chunks = await query(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
            max(vector_dims(embedding)) AS dim,
            count(*) FILTER (WHERE coordinates_available)::int AS with_coords
       FROM literature_chunks WHERE book_source_id = $1`,
    [sourceId]
  );
  const lexical = await query(
    `SELECT count(*)::int AS indexed FROM literature_chunks
      WHERE book_source_id = $1 AND search_tsv @@ to_tsquery('english', $2) LIMIT 1`,
    [sourceId, 'and']
  );
  const sample = await query(
    `SELECT page_start, left(source_text, 80) AS excerpt,
            (embedding IS NOT NULL) AS has_embedding, spans
       FROM literature_chunks WHERE book_source_id = $1 ORDER BY chunk_index LIMIT 1`,
    [sourceId]
  );

  const P = pages.rows[0];
  const C = chunks.rows[0];
  console.log('\n================ VERIFY (database only — no PDF parsing) ================');
  console.log(`BOOK             : ${src.title} (${values.book})`);
  console.log(`EDITION          : ${values.edition}`);
  console.log(`SOURCE HASH      : ${src.sha256?.slice(0, 16)}…`);
  console.log(`STATUS           : ${src.ingestion_status}`);
  console.log(`EMBEDDING        : ${src.embedding_model ?? 'n/a'}  dim=${src.embedding_dim ?? 'n/a'}`);
  console.log(`PAGES            : ${P.total} (PDF page_count=${src.page_count})  coord-pages=${P.with_coords}`);
  console.log(`CHUNKS           : ${C.total}  embedded=${C.embedded}  dim=${C.dim ?? 'n/a'}  coord-chunks=${C.with_coords}`);
  console.log(`LEXICAL (FTS)    : GIN tsquery match test returned ${lexical.rows[0].indexed} for "and"`);
  if (sample.rowCount) {
    const s0 = sample.rows[0];
    console.log(`SAMPLE CHUNK     : page ${s0.page_start} | embedding=${s0.has_embedding} | spans=${JSON.stringify(s0.spans).slice(0, 60)}…`);
    console.log(`                   "${s0.excerpt}…"`);
  }
  console.log('=========================================================================');

  const ok =
    P.total === src.page_count &&
    C.total > 0 &&
    (src.ingestion_status !== 'COMPLETED' || (src.embedding_dim ? C.embedded === C.total : true));

  console.log(ok ? '\nVERIFY: PASS' : '\nVERIFY: CHECK FAILURES ABOVE');
  await getPool()?.end();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('VERIFY ERROR:', err.message);
  process.exit(1);
});
