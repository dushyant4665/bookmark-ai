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

// The user gets an answer in the language they asked in — this is not a
// translation layer, it is simply not ignoring the register they typed in.
// Quoted evidence is never rewritten: a quotation must match the DB text.
export function languageRule(answerLanguage = 'en') {
  if (answerLanguage === 'hi') {
    return 'The user wrote in Hindi. Write your answer in Hindi using Devanagari script. Keep character names readable (they may stay in their usual transliteration) and never translate a quoted passage — quote it exactly as the EVIDENCE block has it.';
  }
  if (answerLanguage === 'hinglish') {
    return 'The user wrote in Hinglish (Hindi typed in Roman letters, casual tone). Reply in the same casual Hinglish register, in Roman script, the way a friend would explain it. Never translate a quoted passage — quote it exactly as the EVIDENCE block has it.';
  }
  return 'Reply in the language the user wrote in: an English question gets an English answer, and a Roman-script Hinglish question stays in Roman script — do not switch language or script on your own. Never translate a quoted passage — quote it exactly as the EVIDENCE block has it.';
}

// A short instruction about the FORM the user asked for ("say it again in
// Hindi", "give an example"). It never changes what is claimed — only how.
function formRule(formNote) {
  if (!formNote) return null;
  return `The user's latest message asked for a change of form rather than new content: ${formNote}. Honour that request while staying inside the supplied evidence.`;
}

// The answer is read in a chat column, so it has to LOOK like an answer: a
// direct first line, then structure only where the content has several parts.
// The UI renders paragraphs and "- " bullets and the citation list is attached
// by the backend, so neither markdown noise nor evidence ids belong in prose.
function answerFormatRule() {
  return [
    'Write it the way a good answer reads on screen:',
    '- Open with one or two sentences that answer the question directly.',
    '- When there are several distinct points, list them as short "- " lines, one point each; otherwise stay in plain prose.',
    '- Put a blank line between paragraphs. Use **bold** only for a name or term worth anchoring on. No headings, no tables, no code fences.',
    '- Do not open with filler ("Certainly", "Great question") and do not restate the question.',
    '- Keep it tight — around 150 words unless the question or the evidence genuinely needs more.',
    '- Never write evidence ids (such as [e1] or (e2, e3)) in the answer text; the cited passages are attached below the answer automatically.',
  ].join('\n');
}

// A whole-book question gets a sample spread across the book rather than the
// nearest few passages, and needs to be told what it is holding: without this
// the model described the SAMPLE ("these excerpts contain no summary") instead
// of doing the task, which is exactly the shrug the user is shown.
function wholeBookRule() {
  return [
    'This question is about the BOOK AS A WHOLE, and the passages below are a deliberate sample: one real passage from each slice of the book, in reading order from its first pages to its last. They are not the only text the book contains.',
    '- Answer the question about the book itself from that sample. Summarising, describing the story or stating what the book argues IS the task.',
    '- Do NOT describe or comment on the sample ("the provided passages do not include a summary", "these are only excerpts"). Never hand the user back their own question as a suggestion.',
    '- Cover the arc: what the book opens with, what it develops, what it concludes — in the order the passages arrive.',
    '- Say which parts of the book you did not see only if the sample is genuinely empty or unreadable.',
  ].join('\n');
}

// Replies that carry no evidence — a conversational turn, or a search that
// matched nothing — must not talk about an EVIDENCE block the model never got.
export function plainLanguageRule(answerLanguage = 'en') {
  if (answerLanguage === 'hi') return 'Write your reply in Hindi using Devanagari script.';
  if (answerLanguage === 'hinglish') return 'Write your reply in casual Hinglish (Hindi written in Roman letters), the way a friend talks.';
  return 'Write your reply in English, in the same script the user typed in — a Roman-script "hi bhai" gets a Roman-script answer, not Devanagari.';
}

// A short, honest note written *about the search*, never about the book. This is
// what the user sees when nothing matched, instead of one fixed string repeated
// for every question. It carries no evidence, so it cannot invent a fact.
export function buildNoEvidenceMessages({ question, bookContext = null, searchedTerms = [], answerLanguage = 'en' }) {
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
        '',
        plainLanguageRule(answerLanguage),
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
  answerLanguage = 'en',
  groq = completeChat,
}) {
  try {
    // json:false — this reply is plain prose about the search, not structured
    // output. Groq's json_object mode would otherwise reject it.
    const raw = await groq(buildNoEvidenceMessages({ question, bookContext, searchedTerms, answerLanguage }), { json: false, temperature: 0.5 });
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

// The grounding contract, shared by the JSON and streaming prompts so the two
// cannot drift apart on the one thing users notice: when a refusal is allowed.
function groundingRules({ wholeBook = false, nudge = null } = {}) {
  return [
    ...(nudge ? [`- ${nudge}`] : []),
    '- Do not invent facts, quotations, page numbers, chapter names, or coordinates.',
    '- Do not claim something appears in the book unless the supplied evidence supports it.',
    '- Do not fill gaps with general world knowledge. This application is book-grounded and has no web search.',
    '- Answer FIRST, qualify SECOND. If an excerpt names the person, scene or argument the question asks about, lead with what that excerpt says and cite its id; add at most one short clause about what the passages do not settle.',
    '- A passage that says the thing in different words still says the thing. It does not have to quote the question\'s phrasing to answer it, and a question you can half-answer is not a question you refuse.',
    '- "These passages do not cover that" is a last resort, true only when NO excerpt below touches the person, term or event asked about.',
    // Keep the confidence flag honest about the answer actually written: a reply
    // that states anything drawn from an excerpt must cite that excerpt.
    '- Whatever you write, report it truthfully: if any sentence of your answer comes from an excerpt, list that id and use "partially_supported" or "supported". Only write "insufficient" if your answer draws on nothing below.',
    ...(wholeBook
      ? [
        `- ${wholeBookRule()}`,
        '- Set confidence to "supported" or "partially_supported" and list the ids you drew on.',
      ]
      : [
        '- If the evidence genuinely does not cover the question — including questions about something outside this book (weather, news, other books, a name that does not appear) — do NOT answer it and do NOT guess. Instead write 1-2 plain, natural sentences saying that the passages retrieved from this book do not cover what was asked, name what they asked in your own words, and suggest a closer question about the book. Say it as a limit of the retrieved passages, never as a claim that the book "never mentions" something. Do not repeat a fixed stock sentence — word each one for the question.',
        '- In that case set confidence to "insufficient" and return an empty evidenceIds list.',
      ]),
    '- Do not manufacture certainty.',
  ];
}

// §17 — the grounding contract. Strong, explicit, and small.
export function buildSystemPrompt({ answerLanguage = 'en', formNote = null, wholeBook = false, nudge = null } = {}) {
  return [
    'You are a book research assistant. Answer using ONLY the supplied evidence excerpts from the selected book edition.',
    '',
    'Hard rules:',
    ...groundingRules({ wholeBook, nudge }),
    '',
    '- If supplied evidence conflicts, explain the conflict instead of silently choosing one side.',
    '',
    'Conversation history, when present, is provided ONLY to resolve references (for example, who "he" refers to). It is NOT evidence and never overrides the book.',
    '',
    'Language and form:',
    `- ${languageRule(answerLanguage)}`,
    ...(formNote ? [`- ${formRule(formNote)}`] : []),
    '',
    'Return STRICT JSON only, exactly this shape and nothing else:',
    '{',
    '  "answer": "your grounded answer, or the insufficient-evidence sentence above",',
    '  "evidenceIds": ["e1", "e2"],',
    '  "confidence": "supported" | "partially_supported" | "insufficient"',
    '}',
    '',
    'Write the "answer" string in this shape:',
    answerFormatRule(),
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
export function buildMessages({ question, evidence = [], contextMessages = [], bookContext = null, answerLanguage = 'en', formNote = null, wholeBook = false, nudge = null }) {
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
    { role: 'system', content: buildSystemPrompt({ answerLanguage, formNote, wholeBook, nudge }) },
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

function streamingSystemPrompt({ answerLanguage = 'en', formNote = null, wholeBook = false, nudge = null } = {}) {
  return [
    'You are a book research assistant. Answer using ONLY the supplied evidence excerpts from the selected book edition.',
    '',
    'Hard rules:',
    ...groundingRules({ wholeBook, nudge }),
    '',
    'Conversation history, when present, is provided ONLY to resolve references. It is NOT evidence and never overrides the book.',
    '',
    'Language and form:',
    `- ${languageRule(answerLanguage)}`,
    ...(formNote ? [`- ${formRule(formNote)}`] : []),
    '',
    'Output format — follow EXACTLY:',
    `1. Write the answer (no JSON, no code fences) in this shape:`,
    answerFormatRule(),
    `2. Then a line containing only the delimiter: ${CITATION_DELIM}`,
    `3. Then a single JSON object, nothing after it:`,
    `   {"evidenceIds": ["e1","e2"], "confidence": "supported" | "partially_supported" | "insufficient"}`,
    '',
    'evidenceIds MUST be a subset of the ids in the EVIDENCE block, or [] if you relied on none. Never cite an id you were not given. Never put a page number or quotation in the answer unless that exact text is inside the supplied evidence.',
  ].join('\n');
}

export function buildStreamingMessages({ question, evidence = [], contextMessages = [], bookContext = null, answerLanguage = 'en', formNote = null, wholeBook = false, nudge = null }) {
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
    { role: 'system', content: streamingSystemPrompt({ answerLanguage, formNote, wholeBook, nudge }) },
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
  answerLanguage = 'en',
  formNote = null,
  wholeBook = false,
  nudge = null,
  stream = streamChatContent,
  onDelta = null,
  signal = null,
}) {
  const messages = buildStreamingMessages({ question, evidence, contextMessages, bookContext, answerLanguage, formNote, wholeBook, nudge });
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

// One more ask when the model waved away the evidence it was handed. This is not
// a licence to invent: the second call sees the very same excerpts and still may
// only cite ids from them.
export const SECOND_ATTEMPT_RULE =
  'This is a second attempt with the SAME excerpts, and your first reply declined to answer from them. Read them again line by line: if an excerpt quotes the person, scene or argument the question names, answer from it and list that id. Decline again only if not one excerpt below touches the subject at all.';

// A shrug is legitimate when nothing was retrieved. It is not legitimate when
// real passages are in front of the model and it cites none of them.
export function refusedDespiteEvidence(generated, evidence = []) {
  return evidence.length > 0
    && generated?.confidence === 'insufficient'
    && !(generated?.evidenceIds?.length);
}

// Cheap, deterministic check on whether a second attempt is worth paying for:
// do the passages contain any of the words the question itself asked about? A
// question the book cannot touch ("who won the World Cup") stays the honest
// refusal it is, instead of costing a second model call that shrugs again.
export function evidenceMentions(evidence = [], keywords = []) {
  const useful = keywords.map((k) => String(k).toLowerCase().trim()).filter((k) => k.length >= 3);
  if (!useful.length) return true; // nothing to match — let the model have its say
  const haystack = evidence.map((e) => String(e.text ?? '')).join('\n').toLowerCase();
  // Whole words only: "won" is not evidence about a World Cup just because
  // some passage contains the letters inside "woman".
  return useful.some((k) => {
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').test(haystack);
  });
}

// Run grounded generation. `groq` is injectable for tests. Resolves model-
// reported ids to the supplied set and clamps confidence honestly.
export async function generateAnswer({
  question,
  evidence = [],
  contextMessages = [],
  bookContext = null,
  answerLanguage = 'en',
  formNote = null,
  wholeBook = false,
  nudge = null,
  groq = completeChat,
}) {
  const messages = buildMessages({ question, evidence, contextMessages, bookContext, answerLanguage, formNote, wholeBook, nudge });
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
