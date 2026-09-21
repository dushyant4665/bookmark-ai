import { query } from '../db/pool.js';

export async function listBooks() {
  const { rows } = await query(
    `SELECT id, title, author, description, created_at
       FROM books
      ORDER BY title ASC`
  );
  return rows;
}

export async function getBook(bookId) {
  const { rows } = await query(
    `SELECT id, title, author, description, created_at
       FROM books WHERE id = $1`,
    [bookId]
  );
  return rows[0] || null;
}

export async function listEditions(bookId) {
  const { rows } = await query(
    `SELECT be.id, be.label, be.language, be.total_pages,
            bs.id IS NOT NULL AS has_source,
            COALESCE(bs.ingestion_status, 'NOT_INGESTED') AS ingestion_status
       FROM book_editions be
       LEFT JOIN book_sources bs ON bs.edition_id = be.id
      WHERE be.book_id = $1
      ORDER BY be.created_at ASC`,
    [bookId]
  );
  return rows;
}
