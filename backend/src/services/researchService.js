import { query as defaultQuery } from '../db/pool.js';
import { makeEmbeddingProvider, embedQuery } from '../ingest/embeddingProvider.js';
import { understandQuery } from '../retrieval/queryUnderstanding.js';
import { vectorRetrieval } from '../retrieval/vectorRetrieval.js';
import { lexicalRetrieval } from '../retrieval/lexicalRetrieval.js';
import { rrfFusion } from '../retrieval/hybridFusion.js';
import { toEvidence, toCitation } from '../retrieval/evidence.js';
import { attachRectsToEvidence } from '../retrieval/geometry.js';
import { makeReranker, rerank } from '../rag/reranker.js';
import {
  generateAnswer,
  generateAnswerStreaming,
  decideSufficiency,
  generateNoEvidenceNote,
  noEvidenceFallback,
} from '../rag/generation.js';
import { groqConfigured, completeChat, streamChatContent } from '../services/groqService.js';
import { ragConfig } from '../config/rag.js';

// ResearchService (Phase 3) — the reusable brain.
//
//   HTTP/SSE transport  ->  researchQuery()  ->  retrieval  ->  rerank  ->  Groq
//
// This module is deliberately independent of Express: it takes a plain input
// object and injectable dependencies so the whole pipeline is unit-testable with
// mocks while production uses the real pg/pgvector/FTS/embedding/Groq seams.
// Nothing is fabricated: if a required provider or the indexed book is missing
// we throw a typed code the route turns into an honest SSE error.

class ResearchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Validate that the edition truly belongs to the book and resolve its single
// source + ingestion state. Never trust ids handed by the frontend (§26).
async function validateBookEdition(runQuery, bookId, editionId) {
  const { rows } = await runQuery(
    `SELECT b.id AS book_id, b.title AS book_title,
            be.id AS edition_id, be.label AS edition_label,
            bs.id AS source_id, bs.ingestion_status
       FROM book_editions be
       JOIN books b ON b.id = be.book_id
       LEFT JOIN book_sources bs ON bs.edition_id = be.id
      WHERE be.id = $1 AND be.book_id = $2`,
    [editionId, bookId]
  );
  return rows[0] || null;
}

// Conversation must exist, belong to the user, and match the book+edition.
async function validateConversation(runQuery, { userId, conversationId, bookId, editionId }) {
  const { rows } = await runQuery(
    `SELECT id, user_id, book_id, edition_id FROM conversations WHERE id = $1`,
    [conversationId]
  );
  const convo = rows[0];
  if (!convo) throw new ResearchError('CONVERSATION_NOT_FOUND');
  if (convo.user_id !== userId) throw new ResearchError('FORBIDDEN');
  if (convo.book_id !== bookId || convo.edition_id !== editionId) {
    throw new ResearchError('CONVERSATION_SCOPE_MISMATCH');
  }
  return convo;
}

// Recent prior turns for reference resolution only (oldest -> newest).
async function loadRecentMessages(runQuery, conversationId, limit) {
  const { rows } = await runQuery(
    `SELECT role, content FROM conversation_messages
      WHERE conversation_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse();
}

async function persistExchange(runQuery, { conversationId, userText, answerText, evidenceMeta }) {
  await runQuery(
    `INSERT INTO conversation_messages (conversation_id, role, content, evidence)
     VALUES ($1, 'user', $2, NULL)`,
    [conversationId, userText]
  );
  await runQuery(
    `INSERT INTO conversation_messages (conversation_id, role, content, evidence)
     VALUES ($1, 'assistant', $2, $3::jsonb)`,
    [conversationId, answerText, JSON.stringify(evidenceMeta)]
  );
  await runQuery(`UPDATE conversations SET updated_at = now() WHERE id = $1`, [conversationId]);
}

export async function researchQuery(input, deps = {}) {
  const {
    runQuery = defaultQuery,
    makeProvider = makeEmbeddingProvider,
    groq = completeChat,
    now = () => Date.now(),
    emit = () => {},
    signal = null,
  } = deps;
  const reranker = 'reranker' in deps ? deps.reranker : makeReranker();
  // `stream` (an async generator of Groq content deltas) is injected by the SSE
  // route to enable real token streaming. Without it we run the Phase 3
  // single-shot structured generation, which keeps this pipeline unit-testable
  // and usable over plain HTTP.
  const stream = deps.stream;
  const streaming = typeof stream === 'function';

  const { userId, conversationId, bookId, editionId, message } = input || {};

  // --- §4/§5 validation -----------------------------------------------------
  const text = String(message ?? '').trim();
  if (!userId || !conversationId || !bookId || !editionId) {
    throw new ResearchError('VALIDATION_ERROR');
  }
  if (!text || text.length > ragConfig.maxMessageLength) {
    throw new ResearchError('VALIDATION_ERROR');
  }

  const scope = await validateBookEdition(runQuery, bookId, editionId);
  if (!scope) throw new ResearchError('BOOK_EDITION_INVALID');
  if (!scope.source_id || scope.ingestion_status !== 'COMPLETED') {
    throw new ResearchError('BOOK_NOT_INDEXED');
  }
  await validateConversation(runQuery, { userId, conversationId, bookId, editionId });

  emit('context_resolved', { bookTitle: scope.book_title, editionLabel: scope.edition_label });

  // --- §6/§7/§8 query understanding ----------------------------------------
  const recent = await loadRecentMessages(runQuery, conversationId, ragConfig.contextMessageLimit);
  const understood = understandQuery({ message: text, recentMessages: recent });
  if (understood.isFollowUp && understood.searchQuery !== understood.original) {
    emit('query_rewritten', { originalQuery: understood.original, searchQuery: understood.searchQuery });
  }

  // --- §9/§10 hybrid retrieval (real providers only) ------------------------
  // The vector leg needs a reachable embedding provider. When it is not
  // configured — or the network denies it — we degrade HONESTLY to lexical-only
  // retrieval (real PostgreSQL FTS). We never fake a vector or fabricate hits.
  let embedMs = 0;
  let vectorResults = [];
  let vectorUnavailable = false;
  let provider = null;
  try {
    provider = makeProvider();
  } catch {
    vectorUnavailable = true;
  }
  if (!vectorUnavailable) {
    emit('searching', { stage: 'vector' });
    const t0 = now();
    try {
      const vector = await embedQuery(provider, understood.searchQuery, { expectedDim: ragConfig.embeddingDim });
      embedMs = now() - t0;
      vectorResults = await vectorRetrieval({
        vector,
        bookId,
        editionId,
        sourceId: scope.source_id,
        runQuery,
      });
    } catch {
      vectorUnavailable = true;
      vectorResults = [];
    }
  }

  const t1 = now();
  // The vector leg is only a real signal if it returned rows. It is empty when
  // the provider is unreachable (vectorUnavailable) OR when the indexed
  // embeddings are absent (NULL) and similarity returns nothing. In both cases
  // full-text retrieval is the only honest signal left, so always run it.
  const vectorsEmpty = vectorUnavailable || vectorResults.length === 0;
  const runLexical = vectorsEmpty || understood.lexicalNeeded;
  // websearch_to_tsquery ANDs the content words of a full sentence, which
  // strands recall to 0 when it is our only signal. When the vector leg gave
  // nothing, match ANY key term instead; OR-ing the query's own words lets
  // ts_rank reward the passages that carry the most of them. Each word is
  // quoted so a multi-word name stays a phrase; websearch honours quotes.
  const recallTerms = (understood.keywords ?? []).map((k) => `"${k}"`).join(' OR ');
  const lexicalQuery = vectorsEmpty && recallTerms ? recallTerms : understood.searchQuery;
  if (runLexical) emit('searching', { stage: 'lexical' });
  const lexicalResults = runLexical
    ? await lexicalRetrieval({
        text: lexicalQuery,
        bookId,
        editionId,
        sourceId: scope.source_id,
        runQuery,
      })
    : [];
  const retrievalMs = now() - t1;

  // With no real retrieval signal at all, there is nothing to ground on.
  if (vectorUnavailable && !runLexical) {
    throw new ResearchError('EMBEDDING_NOT_CONFIGURED');
  }

  // --- §11/§12 fusion + dedup ----------------------------------------------
  const t2 = now();
  const fused = rrfFusion(vectorResults, lexicalResults, { limit: ragConfig.hybridCandidateCount });
  const rerankDecision = decideSufficiency(fused);

  emit('retrieval_complete', {
    vectorCandidates: vectorResults.length,
    lexicalCandidates: lexicalResults.length,
    hybridCandidates: fused.length,
  });

  // §20/§21 stop before spending a Groq call on weak/no evidence. Nothing is
  // generated *about the book* here — the only model call we make is one that
  // describes the miss itself, so the user gets a specific, human reply instead
  // of the same canned sentence on every input. Still zero evidence => still
  // zero claims, and citations stay empty.
  if (!rerankDecision.sufficient) {
    const searchedTerms = [
      ...(understood.keywords ?? []),
      ...(understood.resolvedSubject ? [understood.resolvedSubject] : []),
    ];
    const canAsk = groqConfigured();
    const answer = canAsk
      ? await generateNoEvidenceNote({
          question: text,
          bookContext: { title: scope.book_title, editionLabel: scope.edition_label },
          searchedTerms,
          groq,
        })
      : noEvidenceFallback({
          question: text,
          bookContext: { title: scope.book_title },
          searchedTerms,
        });

    const debug = buildDebug({
      understood, vectorResults, lexicalResults, fused,
      rerankProvider: 'NOT_RUN', finalCount: 0, embedMs, retrievalMs,
      rerankMs: 0, generateMs: 0, insufficient: true, vectorUnavailable,
    });
    const result = {
      status: 'insufficient',
      answer,
      confidence: 'insufficient',
      citations: [],
      evidenceIds: [],
      bookId,
      editionId,
      conversationId,
      debug,
    };
    // Preserve Phase 3 insufficient behavior, surfaced the same way as an answer
    // so the UI never sits stuck waiting for a stream that isn't coming.
    emit('answer_chunk', { delta: answer });
    emit('sources_ready', { sources: [] });
    await persistExchange(runQuery, {
      conversationId,
      userText: text,
      answerText: answer,
      evidenceMeta: { confidence: 'insufficient', evidenceIds: [], reason: 'insufficient_retrieval_signal' },
    });
    return result;
  }

  // --- §14/§15 rerank + evidence budget ------------------------------------
  const t3 = now();
  const { provider: rerankProvider, ranked } = await rerank({
    query: understood.searchQuery,
    candidates: fused,
    reranker,
    topN: ragConfig.rerankerTopN,
  });
  const finalCandidates = ranked.slice(0, ragConfig.finalEvidenceCount);
  // §18 opaque ids in final-evidence order; e1 is the strongest.
  const evidence = finalCandidates.map((c, i) => toEvidence(c, `e${i + 1}`));
  const rerankMs = now() - t3;

  // Report the reranker truthfully: only label it configured when a real
  // provider actually produced the ordering (never for the hybrid fallback).
  const rerankConfigured =
    rerankProvider && rerankProvider !== 'NOT_CONFIGURED' && rerankProvider !== 'HYBRID_FALLBACK_AFTER_ERROR';
  emit('reranking', { provider: rerankConfigured ? 'configured_reranker' : 'hybrid_fallback' });
  emit('evidence_selected', { evidenceCount: evidence.length });

  // --- §16/§17 grounded generation -----------------------------------------
  emit('generating', {});
  const t4 = now();
  const genArgs = {
    question: understood.original,
    evidence,
    contextMessages: recent,
    bookContext: { title: scope.book_title, editionLabel: scope.edition_label },
  };
  let generated;
  if (streaming) {
    // Real token stream: forward Groq's actual deltas as answer_chunk events,
    // then validate the model's evidence selection from the structured trailer.
    if (stream === streamChatContent && !groqConfigured()) throw new ResearchError('GROQ_NOT_CONFIGURED');
    generated = await generateAnswerStreaming({
      ...genArgs,
      stream,
      onDelta: (delta) => emit('answer_chunk', { delta }),
      signal,
    });
  } else {
    if (groq === completeChat && !groqConfigured()) throw new ResearchError('GROQ_NOT_CONFIGURED');
    generated = await generateAnswer({ ...genArgs, groq });
    emit('answer_chunk', { delta: generated.answer });
  }
  const generateMs = now() - t4;

  // --- §19 citation resolution: model ids -> real DB evidence --------------
  // Backend owns ALL citation truth: only ids we handed the model can resolve,
  // and every resolved citation carries its real page/text/spans/rects from the
  // database. Coordinates are attached here — never invented by the model.
  await attachRectsToEvidence({ runQuery, evidence });
  const byId = new Map(evidence.map((e) => [e.evidenceId, e]));
  const citations = generated.evidenceIds.map((id) => toCitation(byId.get(id))).filter(Boolean);

  emit('validation_complete', {
    acceptedCount: citations.length,
    rejectedCount: generated.rejectedEvidenceIds?.length ?? 0,
  });
  emit('sources_ready', { sources: citations });

  const debug = buildDebug({
    understood, vectorResults, lexicalResults, fused,
    rerankProvider, finalCount: evidence.length,
    embedMs, retrievalMs, rerankMs, generateMs, insufficient: false,
    rejectedEvidenceIds: generated.rejectedEvidenceIds, vectorUnavailable,
  });

  const result = {
    status: 'ok',
    answer: generated.answer,
    confidence: generated.confidence,
    citations,
    evidenceIds: generated.evidenceIds,
    rejectedEvidenceIds: generated.rejectedEvidenceIds,
    bookId,
    editionId,
    conversationId,
    debug,
  };

  await persistExchange(runQuery, {
    conversationId,
    userText: text,
    answerText: generated.answer,
    // Compact metadata only — never the whole evidence payload (§22).
    evidenceMeta: {
      confidence: generated.confidence,
      evidenceIds: generated.evidenceIds,
      chunkIds: citations.map((c) => c.chunkId),
      pages: citations.map((c) => c.page),
    },
  });

  return result;
}

function buildDebug({
  understood, vectorResults, lexicalResults, fused, rerankProvider,
  finalCount, embedMs, retrievalMs, rerankMs, generateMs, insufficient, rejectedEvidenceIds = [], vectorUnavailable = false,
}) {
  // §23 internal-only. Timings are measured, never fabricated. The route only
  // forwards this when explicitly requested (debug mode), never to normal users.
  return {
    query: understood.original,
    rewrittenQuery: understood.isFollowUp ? understood.searchQuery : null,
    resolvedSubject: understood.resolvedSubject,
    counts: {
      vector: vectorResults.length,
      lexical: lexicalResults.length,
      hybrid: fused.length,
      reranked: fused.length,
      finalEvidence: finalCount,
    },
    reranker: typeof rerankProvider === 'string' ? rerankProvider : rerankProvider,
    insufficient,
    vectorUnavailable,
    rejectedEvidenceIds,
    timingMs: { embed: embedMs, retrieval: retrievalMs, rerank: rerankMs, generate: generateMs },
    providerConfigured: { embedding: !vectorUnavailable, groq: groqConfigured() },
  };
}

export { ResearchError };
