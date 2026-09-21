import { query as defaultQuery } from '../db/pool.js';
import { makeEmbeddingProvider, embedQuery } from '../ingest/embeddingProvider.js';
import { understandQuery } from '../retrieval/queryUnderstanding.js';
import { vectorRetrieval } from '../retrieval/vectorRetrieval.js';
import { lexicalRetrieval } from '../retrieval/lexicalRetrieval.js';
import { spreadRetrieval } from '../retrieval/spreadRetrieval.js';
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
  plainLanguageRule,
} from '../rag/generation.js';import { groqConfigured, completeChat, streamChatContent } from '../services/groqService.js';
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

// ---------------------------------------------------------------------------
// Conversational turns
//
// A turn with nothing searchable in it is talk about the conversation, not a
// question to the book; searching it used to produce "I could not find the
// words chal, bhai, thik". There are two very different kinds, and they get
// very different replies:
//   - a request about the PREVIOUS answer ("hindi me bta", "aage badhao",
//     "thoda detail me") → re-serve the last real book question in that form;
//   - small talk ("hello", "ok", "thanks") → answer as a conversation would,
//     even when an earlier book question is on screen.

// Names used to tell the model which language the user asked to be answered in.
const LANGUAGE_NAMES = { hi: 'Hindi', hinglish: 'Hinglish', en: 'English' };

// Order matters: the most specific request wins.
const FORM_HINTS = [
  [/\b(dobara|dubara|again|phir|fir|repeat|rephrase)\b/i, 'say it again'],
  [/\b(aage|age|jaari|zari|continue|next)\b/i, 'continue from where the previous answer stopped'],
  [/\b(detail|zyada|jyada|bahut|poora|pura|elaborate|expand)\b/i, 'go into more detail'],
  [/\b(?:example|udahar)\w*/i, 'add a concrete example'],
  [/\b(simple|simplify|easily|asani|samjha|smj|clear)\b/i, 'put it more simply'],
  [/\b(short|chhota|chota|concise)\b/i, 'keep it shorter'],
];

function describeForm(metaText) {
  const hit = FORM_HINTS.find(([re]) => re.test(metaText));
  return hit ? hit[1] : null;
}

// Walk the recent turns backwards for the last message that was actually a
// question about the book. The meta turn is an instruction about ITS answer.
function lastBookQuestion(recentMessages = []) {
  for (let i = recentMessages.length - 1; i >= 0; i -= 1) {
    const m = recentMessages[i];
    if (m?.role !== 'user') continue;
    const prior = understandQuery({ message: m.content, recentMessages: [] });
    if (prior.kind === 'book') return prior;
  }
  return null;
}

function buildConversationalMessages({ text, bookTitle, language, social }) {
  return [
    {
      role: 'system',
      content: [
        social
          ? `You are the research assistant for "${bookTitle}". The user's message is small talk — a greeting, an acknowledgement or a word aimed at you — not a question about the book, so it is not something to look up.`
          : `You are the research assistant for "${bookTitle}". The user's message asks you to change the form of an earlier answer, but there is no earlier question in this chat for it to apply to, so there is nothing to restate.`,
        '',
        `Reply in 1-2 warm, natural sentences${social ? ', the way a helpful person answers a greeting' : ''}: acknowledge what they said, then ask what they would like to know about the book. Say in your own words that you answer from this book itself and that each answer comes with the exact page it came from.`,
        '',
        'ABSOLUTE RULES — you have no retrieved passages right now:',
        '- Do not state, hint at or guess any fact, event, character, argument, quotation, chapter or page from any book.',
        '- Do not say that you searched, found or could not find anything.',
        '- No JSON, no markdown, no bullet lists, never begin with "As an AI".',
        '',
        plainLanguageRule(language),
      ].join('\n'),
    },
    { role: 'user', content: `USER MESSAGE: ${text}` },
  ];
}

// Used when the model is unavailable — still written in the user's language, and
// still claiming nothing about the book.
function conversationalFallback(language) {
  if (language === 'hi') {
    return 'नमस्ते! मैं इस किताब के बारे में आपके सवालों का जवाब दे सकता हूँ, और हर जवाब के साथ ये भी बताता हूँ कि वह किस पेज से आया। किताब से जुड़ा कोई सवाल पूछिए।';
  }
  if (language === 'hinglish') {
    return 'Hello bhai! Bol, is kitab ke baare me kya jaanna hai — main jawab seedhi usi kitab ki lines se deta hu aur ye bhi bata deta hu ki baat kaunse page par hai.';
  }
  return 'Hello! Ask me anything about this book and I will answer from its own passages, with the exact page each answer came from.';
}

async function respondToConversationalTurn({
  runQuery, conversationId, bookId, editionId, text, understood, scope, groq, emit, now,
}) {
  const social = understood.intent === 'social';
  emit('retrieval_skipped', { reason: social ? 'small_talk' : 'no_previous_question' });
  emit('generating', {});
  const t0 = now();
  const language = understood.language;
  let answer = '';
  try {
    const raw = await groq(
      buildConversationalMessages({ text, bookTitle: scope.book_title, language, social }),
      { json: false, temperature: 0.6 }
    );
    if (typeof raw === 'string') answer = raw.trim();
  } catch {
    // An unconfigured or failing model must not break a greeting.
    answer = '';
  }
  if (!answer || answer.length > 600) answer = conversationalFallback(language);
  const generateMs = now() - t0;

  emit('answer_chunk', { delta: answer });
  emit('sources_ready', { sources: [] });
  await persistExchange(runQuery, {
    conversationId,
    userText: text,
    answerText: answer,
    evidenceMeta: { confidence: 'conversational', evidenceIds: [], reason: 'conversational_turn' },
  });

  return {
    status: 'conversational',
    answer,
    confidence: 'conversational',
    citations: [],
    evidenceIds: [],
    bookId,
    editionId,
    conversationId,
    debug: buildDebug({
      understood, vectorResults: [], lexicalResults: [], fused: [],
      rerankProvider: 'NOT_RUN', finalCount: 0,
      embedMs: 0, retrievalMs: 0, rerankMs: 0, generateMs, insufficient: false,
      conversational: true,
    }),
  };
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

  // A turn that asks for another LANGUAGE or another FORM of the previous
  // answer is re-served against the last real book question — the evidence
  // still comes from a real retrieval run. A SOCIAL turn ("hello", "ok",
  // "thanks") is answered as conversation instead: replaying the previous
  // answer for a greeting is what made "hello" produce a paragraph about the
  // Karamazov narrator.
  if (understood.kind === 'meta' && understood.intent === 'social') {
    return await respondToConversationalTurn({
      runQuery, conversationId, bookId, editionId, text, understood, scope, groq, emit, now,
    });
  }
  const prior = understood.kind === 'meta' ? lastBookQuestion(recent) : null;
  if (understood.kind === 'meta' && !prior) {
    return await respondToConversationalTurn({
      runQuery, conversationId, bookId, editionId, text, understood, scope, groq, emit, now,
    });
  }
  const turn = prior ? { ...prior, language: understood.language } : understood;
  // Tell the model plainly that the message it is being handed is the previous
  // question, and what the user's latest words actually asked for — a change of
  // form, never new content to invent.
  const formNote = prior
    ? `their latest message was only "${understood.original}", which asks you to ${understood.intent === 'language' ? `say it in ${LANGUAGE_NAMES[understood.language] ?? 'that language'}` : (describeForm(understood.original) ?? 'answer it again')}`
    : null;
  if (turn.isFollowUp && turn.searchQuery !== turn.original) {
    emit('query_rewritten', { originalQuery: turn.original, searchQuery: turn.searchQuery });
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
      const vector = await embedQuery(provider, turn.searchQuery, { expectedDim: ragConfig.embeddingDim });
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
  const runLexical = vectorsEmpty || turn.lexicalNeeded;
  // websearch_to_tsquery ANDs the content words of a full sentence, which
  // strands recall to 0 when it is our only signal. When the vector leg gave
  // nothing, match ANY key term instead; OR-ing the query's own words lets
  // ts_rank reward the passages that carry the most of them. Each word is
  // quoted so a multi-word name stays a phrase; websearch honours quotes.
  const recallTerms = (turn.keywords ?? []).map((k) => `"${k}"`).join(' OR ');
  const lexicalQuery = vectorsEmpty && recallTerms ? recallTerms : turn.searchQuery;
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

  // A whole-book question ("what is the story?", "what is this about?") is not
  // answerable from the five chunks nearest that sentence — they come from one
  // corner of the book, and the model honestly reported that they contain no
  // summary. For those turns the evidence is one real passage sampled from each
  // slice of the book, in reading order.
  let spread = [];
  if (turn.scope === 'whole_book') {
    try {
      spread = await spreadRetrieval({
        bookId,
        editionId,
        sourceId: scope.source_id,
        tiles: ragConfig.finalEvidenceCount,
        runQuery,
      });
    } catch {
      spread = []; // a failed sample must not break the turn: fall back to hybrid
    }
  }
  const useSpread = spread.length >= 2;

  emit('retrieval_complete', {
    vectorCandidates: vectorResults.length,
    lexicalCandidates: lexicalResults.length,
    hybridCandidates: fused.length,
    spreadCandidates: spread.length,
  });

  // §20/§21 stop before spending a Groq call on weak/no evidence. Nothing is
  // generated *about the book* here — the only model call we make is one that
  // describes the miss itself, so the user gets a specific, human reply instead
  // of the same canned sentence on every input. Still zero evidence => still
  // zero claims, and citations stay empty.
  if (!useSpread && !rerankDecision.sufficient) {
    const searchedTerms = [
      ...(turn.keywords ?? []),
      ...(turn.resolvedSubject ? [turn.resolvedSubject] : []),
    ];
    const canAsk = groqConfigured();
    const answer = canAsk
      ? await generateNoEvidenceNote({
          question: turn.original,
          bookContext: { title: scope.book_title, editionLabel: scope.edition_label },
          searchedTerms,
          answerLanguage: understood.language,
          groq,
        })
      : noEvidenceFallback({
          question: turn.original,
          bookContext: { title: scope.book_title },
          searchedTerms,
        });

    const debug = buildDebug({
      understood: turn, vectorResults, lexicalResults, fused,
      rerankProvider: 'NOT_RUN', finalCount: 0, embedMs, retrievalMs,
      rerankMs: 0, generateMs: 0, insufficient: true, vectorUnavailable,
      asked: prior ? text : null,
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
  let rerankProvider = 'NOT_RUN';
  let finalCandidates;
  if (useSpread) {
    // The sample IS the evidence set, in page order. Reranking it by similarity
    // to "what is the story" would collapse it back onto one region of the book.
    finalCandidates = spread;
  } else {
    const ranked = await rerank({
      query: turn.searchQuery,
      candidates: fused,
      reranker,
      topN: ragConfig.rerankerTopN,
    });
    rerankProvider = ranked.provider;
    finalCandidates = ranked.ranked.slice(0, ragConfig.finalEvidenceCount);
  }
  // §18 opaque ids in final-evidence order; e1 is the strongest.
  const evidence = finalCandidates.map((c, i) => toEvidence(c, `e${i + 1}`));
  const rerankMs = now() - t3;

  // Report the reranker truthfully: only label it configured when a real
  // provider actually produced the ordering (never for the hybrid fallback).
  const rerankConfigured =
    rerankProvider && rerankProvider !== 'NOT_CONFIGURED' && rerankProvider !== 'HYBRID_FALLBACK_AFTER_ERROR';
  emit('reranking', {
    provider: useSpread ? 'whole_book_sample' : rerankConfigured ? 'configured_reranker' : 'hybrid_fallback',
  });
  emit('evidence_selected', { evidenceCount: evidence.length });

  // --- §16/§17 grounded generation -----------------------------------------
  emit('generating', {});
  const t4 = now();
  const genArgs = {
    question: turn.original,
    evidence,
    contextMessages: recent,
    bookContext: { title: scope.book_title, editionLabel: scope.edition_label },
    answerLanguage: understood.language,
    formNote,
    // Tells the prompt it is holding a spread sample of the whole book, so it
    // summarises instead of reporting that the excerpts lack a summary.
    wholeBook: useSpread,
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
    understood: turn, vectorResults, lexicalResults, fused,
    rerankProvider, finalCount: evidence.length,
    embedMs, retrievalMs, rerankMs, generateMs, insufficient: false,
    rejectedEvidenceIds: generated.rejectedEvidenceIds, vectorUnavailable,
    asked: prior ? text : null,
    spreadCount: spread.length,
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
  conversational = false, asked = null, spreadCount = 0,
}) {
  // §23 internal-only. Timings are measured, never fabricated. The route only
  // forwards this when explicitly requested (debug mode), never to normal users.
  return {
    query: understood.original,
    // When the user's message was a form request, this is the question it pointed at.
    ...(asked ? { asked } : {}),
    rewrittenQuery: understood.isFollowUp ? understood.searchQuery : null,
    resolvedSubject: understood.resolvedSubject,
    scope: understood.scope ?? 'passage',
    counts: {
      vector: vectorResults.length,
      lexical: lexicalResults.length,
      hybrid: fused.length,
      reranked: fused.length,
      spread: spreadCount,
      finalEvidence: finalCount,
    },
    reranker: typeof rerankProvider === 'string' ? rerankProvider : rerankProvider,
    insufficient,
    ...(conversational ? { conversational: true } : {}),
    vectorUnavailable,
    rejectedEvidenceIds,
    timingMs: { embed: embedMs, retrieval: retrievalMs, rerank: rerankMs, generate: generateMs },
    providerConfigured: { embedding: !vectorUnavailable, groq: groqConfigured() },
  };
}

export { ResearchError };
