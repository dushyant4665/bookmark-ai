import { query } from '../db/pool.js';
import { SELECT_COLUMNS, rowToCandidate, toEvidence, toCitation } from '../retrieval/evidence.js';
import { attachRectsToEvidence } from '../retrieval/geometry.js';

// Rebuild the exact citation payloads for a stored assistant turn from the chunk
// ids persisted with it. Rows stay compact (ids + pages only) while the client
// still gets real text/page/rects after a refresh — citation truth keeps coming
// from PostgreSQL and is never parsed out of the answer prose.
async function expandCitations(meta) {
  const ids = Array.isArray(meta?.chunkIds) ? meta.chunkIds.filter(Boolean) : [];
  if (!ids.length) return [];
  const { rows } = await query(
    `SELECT ${SELECT_COLUMNS}
       FROM literature_chunks c
      WHERE c.id = ANY($1::uuid[])`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  // Preserve the original e1..eN order the answer was grounded on.
  const evidence = ids
    .map((id, i) => {
      const row = byId.get(id);
      return row ? toEvidence({ ...rowToCandidate(row), retrieval: {} }, `e${i + 1}`) : null;
    })
    .filter(Boolean);
  await attachRectsToEvidence({ runQuery: query, evidence });
  return evidence.map(toCitation);
}

export async function createConversation({ userId, bookId, editionId, title }) {
  const { rows } = await query(
    `INSERT INTO conversations (user_id, book_id, edition_id, title)
     VALUES ($1, $2, $3, COALESCE($4, 'New conversation'))
     RETURNING id, user_id, book_id, edition_id, title, created_at, updated_at`,
    [userId, bookId, editionId, title || null]
  );
  return rows[0];
}

export async function listConversations({ userId, bookId, editionId }) {
  const { rows } = await query(
    `SELECT id, book_id, edition_id, title, created_at, updated_at
       FROM conversations
      WHERE user_id = $1 AND book_id = $2 AND edition_id = $3
      ORDER BY updated_at DESC`,
    [userId, bookId, editionId]
  );
  return rows;
}

export async function getConversation({ userId, conversationId }) {
  const { rows } = await query(
    `SELECT id, user_id, book_id, edition_id, title, created_at, updated_at
       FROM conversations
      WHERE id = $1 AND user_id = $2`,
    [conversationId, userId]
  );
  return rows[0] || null;
}

export async function listMessages({ userId, conversationId }) {
  const convo = await getConversation({ userId, conversationId });
  if (!convo) return null;
  const { rows } = await query(
    `SELECT id, role, content, evidence, created_at
       FROM conversation_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC`,
    [conversationId]
  );
  // Rehydrate each assistant turn's citations so a refreshed browser sees the
  // same real sources it saw live — resolved from the DB, never from the prose.
  const messages = [];
  for (const r of rows) {
    const meta = typeof r.evidence === 'string' ? safeParse(r.evidence) : r.evidence;
    messages.push({
      id: r.id,
      role: r.role,
      content: r.content,
      created_at: r.created_at,
      confidence: meta?.confidence ?? null,
      citations: r.role === 'assistant' ? await expandCitations(meta) : [],
    });
  }
  return { conversation: convo, messages };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
