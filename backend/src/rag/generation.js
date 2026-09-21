import { ragConfig } from '../config/rag.js';
import { completeChat, streamChatContent } from '../services/groqService.js';

// Grounded generation (Phase 3 §17–§21).
//
// Everything here is transport-independent and unit-testable: a pure prompt
// builder, a tolerant JSON parser, and a membership-only evidence-id validator.
// The backend — never the model — owns citation truth (§18, §19): the model may
// only reference evidence ids we handed it, and it can't authoritatively supply
// pages, quotes or coordinates (those resolve back to PostgreSQL rows later).

export const INSUFFICIENT_MESSAGE =
  "I don't have enough evidence in the indexed text to answer that reliably.";

// A short, honest note written *about the search*, never about the book. This is
// what the user sees when nothing matched, instead of one fixed string repeated
// for every question. It carries no evidence, so it cannot invent a fact.
export function buildNoEvidenceMessages({ question, bookContext = null, searchedTerms = [] }) {
  const book = bookContext?.title ? `"${bookContext.title}"` : 'this book';
  const terms = searchedTerms.filter(Boolean).slice(0, 6);
  return [
    {
      role: 'system',
      content: [
        `You are the research assistant for ${book}. A search of its indexed text returned no matching passage for the user's question.`,
        '',
        'Write a short reply (2-3 sentences, plain conversational prose) that:',
        '- says plainly that nothing in this book matched what they asked, in your own words;',
        '- names what they were looking for so the reply feels specific, not boilerplate;',
        '- offers one or two concrete next steps (a different spelling of a name, a broader or related term, or a theme to ask about instead).',
        '',
        'ABSOLUTE RULES — this reply has zero evidence behind it:',
        '- Do not state, hint at, or guess any fact, event, character, argument, quotation, chapter or page from the book.',
        '- Do not say what the book "does" cover beyond what is listed as searched terms.',
        '- No JSON, no markdown, no bullet lists, no apology loops, and never begin with "As an AI".',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `QUESTION: ${question}\nSEARCHED TERMS: ${terms.length ? terms.join(', ') : '(the question above)'}`,
    },
  ];
}

// Last-resort wording when the model itself is unavailable. Still specific to
// the question and the book, so it never reads as one canned string.
export function noEvidenceFallback({ question, bookContext = null, searchedTerms = [] }) {
  const book = bookContext?.title ? `"${bookContext.title}"` : 'this book';
  const subject = String(question || '').trim().slice(0, 120) || 'that';
  const termHint = searchedTerms.filter(Boolean).slice(0, 3).join(', ');
  return (
    `I searched ${book} for ${termHint ? `"${termHint}"` : `that — "${subject}"`} and could not find ` +
    `anything matching that wording, so I would rather tell you plainly than guess. ` +
    `Try a different spelling of a name, or ask about a broader theme instead.`
  );
}

// Ask the model to phrase the miss naturally. Any failure degrades to the
// parameterized fallback — never to a fabricated answer.
export async function generateNoEvidenceNote({
  question,
  bookContext = null,
  searchedTerms = [],
  groq = completeChat,
}) {
  try {
    // json:false — this reply is plain prose about the search, not structured
    // output. Groq's json_object mode would otherwise reject it.
    const raw = await groq(buildNoEvidenceMessages({ question, bookContext, searchedTerms }), { json: false, temperature: 0.5 });
    const text = typeof raw === 'string' ? raw.trim() : '';
    // Guard the honesty contract: an empty or absurdly long reply is not worth
    // risking, and the model must not smuggle in an evidence-style answer.
    if (!text || text.length > 900) return noEvidenceFallback({ question, bookContext, searchedTerms });
    return text;
  } catch {
    return noEvidenceFallback({ question, bookContext, searchedTerms });
  }
}


const ALLOWED_CONFIDENCE = new Set(['supported', 'partially_supported', 'insufficient']);

// §17 — the grounding contract. Strong, explicit, and small.
export function buildSystemPrompt() {
  return [
    'You are a book research assistant. Answer using ONLY the supplied evidence excerpts from the selected book edition.',
    '',
    'Hard rules:',
    '- Do not invent facts, quotations, page numbers, chapter names, or coordinates.',
    '- Do not claim something appears in the book unless the supplied evidence supports it.',
    '- Do not fill gaps with general world knowledge. This application is book-grounded and has no web search.',
    '- If the supplied evidence does not actually cover the question — including questions about something outside this book (weather, news, other books, a name that does not appear) — do NOT answer it and do NOT guess. Instead write 1-2 plain, natural sentences that say the passages retrieved from this book do not cover what was asked, name what they asked in your own words, and suggest a closer question about the book. Phrase it as a limit of the retrieved passages, never as a claim that the book "never mentions" something. Do not repeat a fixed stock sentence — word each one for the question.',
    '- In that case set confidence to "insufficient" and return an empty evidenceIds list.',
    '- If supplied evidence conflicts, explain the conflict instead of silently choosing one side.',
    '- Do not manufacture certainty.',
    '',
    'Conversation history, when present, is provided ONLY to resolve references (for example, who "he" refers to). It is NOT evidence and never overrides the book.',
    '',
    'Return STRICT JSON only, exactly this shape and nothing else:',
    '{',
    '  "answer": "your grounded answer, or the insufficient-evidence sentence above",',
    '  "evidenceIds": ["e1", "e2"],',
    '  "confidence": "supported" | "partially_supported" | "insufficient"',
    '}',
    '',
    'evidenceIds MUST be a subset of the ids supplied in the EVIDENCE block. Never cite an id you were not given. Never put a page number or quotation in "answer" unless that exact text is inside the supplied evidence.',
  ].join('\n');
}

// Render evidence with the only fields the model may see: its opaque id, the
// database page, an optional section label, and the DB text. No coordinates.
export function buildEvidenceBlock(evidence = []) {
  if (!evidence.length) return 'EVIDENCE:\n(none retrieved)';
  const lines = ['EVIDENCE:'];
  for (const e of evidence) {
    const page =
      e.pageStart == null
        ? ''
        : e.pageEnd != null && e.pageEnd !== e.pageStart
          ? ` (pages ${e.pageStart}-${e.pageEnd})`
          : ` (page ${e.pageStart})`;
    const chapter = e.section ? ` [${e.section}]` : '';
    lines.push(`[${e.evidenceId}]${page}${chapter}`);
    lines.push(String(e.text ?? '').trim());
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

// Prepend only the most recent conversation turns, and only as reference-
// resolving context — never as evidence (§7).
function buildContextBlock(contextMessages = [], limit = ragConfig.contextMessageLimit) {
  const recent = contextMessages.slice(-limit);
  if (!recent.length) return '';
  const lines = ['CONVERSATION CONTEXT (reference resolution only, not evidence):'];
  for (const m of recent) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content ?? '').trim()}`);
  }
  return lines.join('\n');
}

// §16/§17 — the full message array. Groq receives the question, minimal
// conversation context, the book/edition identity, and ONLY the final evidence.
export function buildMessages({ question, evidence = [], contextMessages = [], bookContext = null }) {
  const parts = [];
  const ctx = buildContextBlock(contextMessages);
  if (ctx) parts.push(ctx, '');
  if (bookContext && (bookContext.title || bookContext.editionLabel)) {
    const title = bookContext.title ? `SELECTED BOOK: ${bookContext.title}` : '';
    const edition = bookContext.editionLabel ? `Edition: ${bookContext.editionLabel}` : '';
    parts.push([title, edition].filter(Boolean).join(' — '), '');
  }
  parts.push(buildEvidenceBlock(evidence), '', `QUESTION: ${question}`);
  return [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: parts.join('\n') },
  ];
}

// ============================================================================
// Phase 4 — real token streaming WITHOUT losing grounding (§14, §15).
//
// Streaming a strict-JSON answer is fragile, so the streaming prompt asks for
// plain answer prose FIRST (which we forward token-by-token) and then, after a
// fixed delimiter, a small JSON trailer with evidenceIds + confidence. The
// trailer is machine data the model was handed (the ids we supplied); we never
// read pages, quotes or coordinates out of the prose. The backend still owns
// citation truth: the ids are membership-checked and resolved to real DB rows.
export const CITATION_DELIM = '###EVIDENCE###';

function streamingSystemPrompt() {
  return [
    'You are a book research assistant. Answer using ONLY the supplied evidence excerpts from the selected book edition.',
    '',
    'Hard rules:',
    '- Do not invent facts, quotations, page numbers, chapter names, or coordinates.',
    '- Do not claim something appears in the book unless the supplied evidence supports it.',
    '- Do not fill gaps with general world knowledge. This application is book-grounded and has no web search.',
    '- If the supplied evidence does not actually cover the question — including questions about something outside this book (weather, news, other books, a name that does not appear) — do NOT answer it and do NOT guess. Instead write 1-2 plain, natural sentences saying that the passages retrieved from this book do not cover what was asked, name what they asked in your own words, and suggest a closer question about the book. Say it as a limit of the retrieved passages, never as a claim that the book "never mentions" something. Do not repeat a fixed stock sentence — word each one for the question.',
    '- In that case set confidence to "insufficient" and return an empty evidenceIds list.',
    '- Do not manufacture certainty.',
    '',
    'Conversation history, when present, is provided ONLY to resolve references. It is NOT evidence and never overrides the book.',
    '',
    'Output format — follow EXACTLY:',
    `1. Write the answer as plain text (no JSON, no markdown fences).`,
    `2. Then a line containing only the delimiter: ${CITATION_DELIM}`,
    `3. Then a single JSON object, nothing after it:`,
    `   {"evidenceIds": ["e1","e2"], "confidence": "supported" | "partially_supported" | "insufficient"}`,
    '',
    'evidenceIds MUST be a subset of the ids in the EVIDENCE block, or [] if you relied on none. Never cite an id you were not given. Never put a page number or quotation in the answer unless that exact text is inside the supplied evidence.',
  ].join('\n');
}

export function buildStreamingMessages({ question, evidence = [], contextMessages = [], bookContext = null }) {
  const parts = [];
  const ctx = buildContextBlock(contextMessages);
  if (ctx) parts.push(ctx, '');
  if (bookContext && (bookContext.title || bookContext.editionLabel)) {
    const title = bookContext.title ? `SELECTED BOOK: ${bookContext.title}` : '';
    const edition = bookContext.editionLabel ? `Edition: ${bookContext.editionLabel}` : '';
    parts.push([title, edition].filter(Boolean).join(' — '), '');
  }
  parts.push(buildEvidenceBlock(evidence), '', `QUESTION: ${question}`);
  return [
    { role: 'system', content: streamingSystemPrompt() },
    { role: 'user', content: parts.join('\n') },
  ];
}

// Incremental splitter that turns a raw token stream into (answerText, trailer).
// It never emits the delimiter or anything after it as answer text, and holds
// back the tail while it might still be a partial delimiter so we don't leak.
export function createAnswerSplitter(delim = CITATION_DELIM) {
  let buffer = '';
  let done = false;
  return {
    // Returns the next safe slice of ANSWER text (possibly ''), or null once the
    // delimiter has been consumed (everything after belongs to the trailer).
    push(chunk) {
      if (done) {
        buffer += chunk;
        return null;
      }
      buffer += chunk;
      const idx = buffer.indexOf(delim);
      if (idx !== -1) {
        // The answer runs up to the delimiter; drop the separator whitespace we
        // asked the model to place before it so it never shows in the UI.
        const answer = buffer.slice(0, idx).replace(/\s+$/, '');
        buffer = buffer.slice(idx + delim.length);
        done = true;
        return answer;
      }
      // Emit everything except a tail that could still be the start of delim.
      const safeLen = Math.max(0, buffer.length - (delim.length - 1));
      const answer = buffer.slice(0, safeLen);
      buffer = buffer.slice(safeLen);
      return answer;
    },
    isDone: () => done,
    trailer: () => (done ? buffer : ''),
    // If the stream ends without a delimiter, the held-back tail was real text.
    flushTail: () => {
      if (done) return '';
      const t = buffer;
      buffer = '';
      return t;
    },
  };
}

// Stream the grounded answer. `stream` is an async generator of content strings
// (real Groq deltas in production; a mock in tests). `onDelta` receives each
// answer-text slice for live forwarding. Returns the same shape as
// generateAnswer so the caller's citation/validation logic is unchanged.
export async function generateAnswerStreaming({
  question,
  evidence = [],
  contextMessages = [],
  bookContext = null,
  stream = streamChatContent,
  onDelta = null,
  signal = null,
}) {
  const messages = buildStreamingMessages({ question, evidence, contextMessages, bookContext });
  const splitter = createAnswerSplitter();
  let answer = '';
  for await (const chunk of stream(messages, { signal })) {
    const piece = splitter.push(chunk);
    if (piece) {
      answer += piece;
      onDelta?.(piece);
    }
  }
  if (!splitter.isDone()) {
    const tail = splitter.flushTail();
    if (tail) {
      answer += tail;
      onDelta?.(tail);
    }
  }

  const parsed = splitter.isDone() ? parseStructuredAnswer(splitter.trailer()) : null;
  const validIds = new Set(evidence.map((e) => e.evidenceId));
  const { accepted, rejected } = validateEvidenceIds(parsed?.evidenceIds, validIds);
  let confidence = normalizeConfidence(parsed?.confidence, accepted.length);
  if (confidence === 'supported' && accepted.length === 0) confidence = 'insufficient';

  if (!answer.trim()) throw new Error('ANSWER_PARSE_FAILED');
  return {
    answer: answer.trim(),
    evidenceIds: accepted,
    rejectedEvidenceIds: rejected,
    confidence,
  };
}

// Tolerant structured-output parse (§18). Groq is asked for json_object, but we
// still strip code fences and grab the outermost {...} before parsing. Returns
// null on unrecoverable input so the caller can fail honestly.
export function parseStructuredAnswer(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(text.slice(start, end + 1));
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

// §18/§19 — membership-only validation. We accept only ids we actually supplied
// and report the rest as rejected; we never trust model-authored metadata.
export function validateEvidenceIds(modelIds, validIdSet) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  const list = Array.isArray(modelIds) ? modelIds : [];
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (validIdSet.has(id)) accepted.push(id);
    else rejected.push(id);
  }
  return { accepted, rejected };
}

function normalizeConfidence(value, acceptedCount) {
  if (ALLOWED_CONFIDENCE.has(value)) return value;
  // Missing/garbage confidence: be honest about what we can actually support.
  return acceptedCount > 0 ? 'partially_supported' : 'insufficient';
}

// §20 — insufficient-evidence heuristic, based on REAL retrieval signals only.
// Rule: require at least `minEvidenceCount` candidates AND the best fused score
// to clear `minEvidenceScore`. With RRF the smallest meaningful non-zero signal
// is one list contributing at rank 1 (≈ 1/(k+1)); a lone weak hit below the
// configured floor is treated as "the book probably can't answer this", so we
// stop before spending a Groq call and never hallucinate.
export function decideSufficiency(fused = [], { minCount = ragConfig.minEvidenceCount, minScore = ragConfig.minEvidenceScore } = {}) {
  const best = fused.length ? Number(fused[0].hybridScore ?? 0) : 0;
  const hasEnough = fused.length >= minCount && best >= minScore;
  return {
    sufficient: hasEnough,
    candidateCount: fused.length,
    bestScore: best,
    reason: !hasEnough ? 'insufficient_retrieval_signal' : 'ok',
  };
}

// Run grounded generation. `groq` is injectable for tests. Resolves model-
// reported ids to the supplied set and clamps confidence honestly.
export async function generateAnswer({
  question,
  evidence = [],
  contextMessages = [],
  bookContext = null,
  groq = completeChat,
}) {
  const messages = buildMessages({ question, evidence, contextMessages, bookContext });
  const raw = await groq(messages);
  const parsed = parseStructuredAnswer(raw);
  if (!parsed) throw new Error('ANSWER_PARSE_FAILED');

  const validIds = new Set(evidence.map((e) => e.evidenceId));
  const { accepted, rejected } = validateEvidenceIds(parsed.evidenceIds, validIds);
  let confidence = normalizeConfidence(parsed.confidence, accepted.length);
  // A model claiming "supported" while selecting nothing is contradictory —
  // downgrade rather than let it overstate certainty.
  if (confidence === 'supported' && accepted.length === 0) confidence = 'insufficient';

  return {
    answer: typeof parsed.answer === 'string' ? parsed.answer : '',
    evidenceIds: accepted,
    rejectedEvidenceIds: rejected,
    confidence,
  };
}
