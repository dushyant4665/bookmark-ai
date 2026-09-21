import { query as defaultQuery } from '../db/pool.js';
import { SELECT_COLUMNS, rowToCandidate } from './evidence.js';
import { ragConfig } from '../config/rag.js';

// Real pgvector cosine retrieval, always scoped to the selected book + edition
// (+ its single source). Never scans the PDF, never loads the whole book, and
// never crosses editions. The similarity computation is done by PostgreSQL.
export async function vectorRetrieval({
  vector,
  bookId,
  editionId,
  sourceId = null,
  topK = ragConfig.vectorTopK,
  runQuery = defaultQuery,
}) {
  if (!Array.isArray(vector) || vector.length === 0) throw new Error('VECTOR_REQUIRED');
  const literal = `[${vector.join(',')}]`;

  // Build a scoped, fully parameterized query. The vector is passed as a
  // pgvector literal bound as a parameter — never string-interpolated.
  const where = ['c.book_id = $2', 'c.edition_id = $3', 'c.embedding IS NOT NULL'];
  const params = [literal, bookId, editionId];
  if (sourceId) {
    params.push(sourceId);
    where.push(`c.book_source_id = $${params.length}`);
  }
  params.push(topK);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT ${SELECT_COLUMNS},
           (c.embedding <=> $1::vector) AS distance
      FROM literature_chunks c
     WHERE ${where.join(' AND ')}
     ORDER BY c.embedding <=> $1::vector
     LIMIT ${limitParam}`;

  const { rows } = await runQuery(sql, params);
  return rows.map((r, i) => ({
    ...rowToCandidate(r),
    retrieval: {
      vectorRank: i + 1,
      vectorScore: 1 - Number(r.distance), // cosine similarity in [-1,1] -> higher is better
      distance: Number(r.distance),
    },
  }));
}
