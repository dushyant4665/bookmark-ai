import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { chatLimiter } from '../middleware/rateLimit.js';
import { startSse } from '../utils/sse.js';
import { researchQuery } from '../services/researchService.js';
import { streamChatContent } from '../services/groqService.js';

const router = Router();

// POST /api/chat/stream — Phase 4 real-time research over SSE.
//
// Transport and research stay separate: this route only frames the stream
// (request id, abort, terminal events); researchQuery emits every intermediate
// event with REAL data (retrieval counts, truthful reranker label, actual Groq
// token deltas, DB-resolved citations). Nothing here is simulated.
const MESSAGE_BY_CODE = {
  VALIDATION_ERROR: 'A non-empty message and book/edition/conversation context are required.',
  CONVERSATION_NOT_FOUND: 'Conversation not found.',
  FORBIDDEN: 'You do not have access to this conversation.',
  CONVERSATION_SCOPE_MISMATCH: 'This conversation belongs to a different book or edition.',
  BOOK_EDITION_INVALID: 'The selected edition does not belong to the selected book.',
  BOOK_NOT_INDEXED: 'This book edition has not been indexed yet.',
  EMBEDDING_NOT_CONFIGURED: 'Query embeddings are not configured, so retrieval cannot run.',
  GROQ_NOT_CONFIGURED: 'The answer model is not configured, so an answer cannot be generated.',
  ANSWER_PARSE_FAILED: 'The research backend returned an unreadable answer.',
  DATABASE_UNAVAILABLE: 'The research database is unavailable right now.',
};

router.post('/stream', requireAuth, chatLimiter, async (req, res) => {
  const sse = startSse(res);
  const requestId = randomUUID();
  // The pipeline emits transport-agnostic events; we bind the request id here so
  // research logic never needs to know about it.
  const emit = (type, data = {}) => sse(type, { requestId, type, ...data });
  const userId = req.userId;
  const { bookId, editionId, conversationId, message } = req.body || {};
  const wantDebug = process.env.RAG_DEBUG === 'true' || req.query.debug === '1';

  // Cancellation: a browser refresh, tab close or Stop click aborts the fetch.
  // We propagate that as an AbortSignal so the Groq stream stops immediately
  // instead of burning tokens for a client that already left.
  const controller = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    controller.abort();
  });

  try {
    emit('request_received', { conversationId, bookId, editionId });

    const result = await researchQuery(
      { userId, conversationId, bookId, editionId, message },
      { emit, signal: controller.signal, stream: streamChatContent }
    );

    if (closed || res.writableEnded) return;
    emit('complete', {
      conversationId: result.conversationId,
      confidence: result.confidence,
      status: result.status,
      evidenceIds: result.evidenceIds,
      ...(wantDebug ? { debug: result.debug } : {}),
    });
    res.end();
  } catch (err) {
    if (closed || controller.signal.aborted) {
      // Client is gone; there is no one left to tell. Just stop cleanly.
      res.end();
      return;
    }
    const code = err?.code || (String(err?.message || '').startsWith('GROQ_ERROR') ? 'GROQ_ERROR' : 'INTERNAL_ERROR');
    emit('error', {
      code,
      message: MESSAGE_BY_CODE[code] || 'The research backend could not complete the request.',
    });
    res.end();
  }
});

export default router;
