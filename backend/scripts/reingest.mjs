// One-off orchestration: replace the text-seeded bookmark data (0 coordinates)
// with a real re-ingest from the generated text-layer PDF, so pages carry real
// x/y text items and chunks are marked coordinates_available. Reuses the SAME
// book / edition / source ids so existing conversations stay valid.
import { resolve } from 'node:path';
import { getPool } from '../src/db/pool.js';
import { ingestBook } from '../src/ingest/ingestBook.js';
import * as store from '../src/ingest/ingestStore.js';

const SLUG = 'brothers-karamazov';
const EDITION = 'db-seeded'; // reuse existing edition id
const PDF = resolve('storage/karamazov.pdf');

const pool = getPool();
if (!pool) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

// Clear ONLY this book's stale pages + chunks before rebuilding.
const src = await pool.query(
  `SELECT bs.id FROM book_sources bs
     JOIN book_editions be ON be.id = bs.edition_id
     JOIN books b ON b.id = be.book_id
    WHERE b.slug = $1 AND be.label = $2`,
  [SLUG, EDITION]
);
for (const row of src.rows) {
  await store.deleteDerived(row.id);
  console.log(`cleared stale pages+chunks for source ${row.id}`);
}

const result = await ingestBook({
  slug: SLUG,
  edition: EDITION,
  file: PDF,
  title: 'The Brothers Karamazov',
  author: 'Fyodor Dostoevsky',
  language: 'en',
  skipEmbeddings: true, // HF embeddings are egress-blocked; lexical retrieval already works
  force: true,
  log: (...a) => console.log(...a),
});

// Verify against real DB values.
const v = await pool.query(
  `SELECT (SELECT count(*) FROM book_pages WHERE book_source_id=$1) pages,
          (SELECT count(*) FROM book_pages WHERE book_source_id=$1 AND coordinates_available) coord_pages,
          (SELECT count(*) FROM literature_chunks WHERE book_source_id=$1) chunks,
          (SELECT count(*) FROM literature_chunks WHERE book_source_id=$1 AND coordinates_available) coord_chunks`,
  [result.sourceId]
);
console.log('\n================ POST-INGEST VERIFY (real DB) ================');
console.log(JSON.stringify({ sourceId: result.sourceId, sha256: result.sha256?.slice(0, 12), ...v.rows[0] }));
console.log('==============================================================');
await pool.end();
process.exit(0);
