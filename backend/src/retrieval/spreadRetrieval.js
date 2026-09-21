import { query as defaultQuery } from '../db/pool.js';
import { SELECT_COLUMNS, rowToCandidate } from './evidence.js';

// Spread retrieval for whole-book questions ("what is the story?", "what is this
// book about?"). Vector + lexical search answer those with five unrelated
// passages from one region of the book, which is why the model kept replying
// that the retrieved text contained no summary.
//
// This asks PostgreSQL for one real chunk from each equal slice of the book, so
// the evidence covers the beginning, the middle and the end in reading order.
// It selects rows that already exist — it never ranks, scores or invents
// anything, and every field still comes from the database.
export async function spreadRetrieval({
  bookId,
  editionId,
  sourceId = null,
  tiles = 6,
  minChars = 160,
  runQuery = defaultQuery,
}) {
  const n = Math.max(1, Math.min(12, Number(tiles) || 1));
  const where = ['c.book_id = $2', 'c.edition_id = $3', 'char_length(c.source_text) >= $4'];
  const params = [n, bookId, editionId, Math.max(0, Number(minChars) || 0)];
  if (sourceId) {
    params.push(sourceId);
    where.push(`c.book_source_id = $${params.length}`);
  }

  const { rows } = await runQuery(
    `WITH scoped AS (
       SELECT c.id, c.page_start, c.chunk_index,
              ntile($1::int) OVER (ORDER BY c.page_start, c.chunk_index) AS tile
         FROM literature_chunks c
        WHERE ${where.join(' AND ')}
     ), picked AS (
       SELECT id, tile,
              row_number() OVER (PARTITION BY tile ORDER BY page_start, chunk_index) AS rn
         FROM scoped
     )
     SELECT ${SELECT_COLUMNS}
       FROM literature_chunks c
       JOIN picked p ON p.id = c.id
      WHERE p.rn = 1
      ORDER BY p.tile`,
    params
  );

  return rows.map((r, i) => ({
    ...rowToCandidate(r),
    retrieval: { spreadRank: i + 1 },
  }));
}
