import { query as defaultQuery } from '../db/pool.js';
import { SELECT_COLUMNS, rowToCandidate } from './evidence.js';
import { ragConfig } from '../config/rag.js';

// PostgreSQL full-text retrieval over the Phase 2 `search_tsv` GIN index.
// Strong for names, quotations, terminology and exact phrases that pure
// semantics can blur. Same evidence shape as vector retrieval so fusion is clean.
export async function lexicalRetrieval({
  text,
  bookId,
  editionId,
  sourceId = null,
  topK = ragConfig.lexicalTopK,
  runQuery = defaultQuery,
}) {
  const term = (text ?? '').trim();
  if (!term) return [];

  const where = [
    'c.book_id = $2',
    'c.edition_id = $3',
    `c.search_tsv @@ websearch_to_tsquery('english', $1)`,
  ];
  const params = [term, bookId, editionId];
  if (sourceId) {
    params.push(sourceId);
    where.push(`c.book_source_id = $${params.length}`);
  }
  params.push(topK);
  const limitParam = `$${params.length}`;

  const sql = `
    SELECT ${SELECT_COLUMNS},
           ts_rank(c.search_tsv, websearch_to_tsquery('english', $1)) AS rank
      FROM literature_chunks c
     WHERE ${where.join(' AND ')}
     ORDER BY rank DESC
     LIMIT ${limitParam}`;

  const { rows } = await runQuery(sql, params);
  return rows.map((r, i) => ({
    ...rowToCandidate(r),
    retrieval: {
      lexicalRank: i + 1,
      lexicalScore: Number(r.rank),
    },
  }));
}
