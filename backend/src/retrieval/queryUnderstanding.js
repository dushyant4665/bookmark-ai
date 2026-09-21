import { ragConfig } from '../config/rag.js';

// Query understanding — deliberately lightweight and deterministic (Phase 3 §6).
// We do NOT call an LLM to rewrite every question. Most questions already carry
// their own subject. We only augment when the current message is anaphoric
// ("why does HE believe that?") and a prior-turn subject can be recovered.
//
// Grounding rule (§7): conversation context only helps RESOLVE REFERENCES. It is
// never treated as book evidence, and we never invent a subject — if none can be
// recovered confidently we preserve the original query and its uncertainty.

const ANAPHORA = /\b(he|him|his|she|her|hers|it|its|they|them|their|this|that|these|those|the former|the latter)\b/i;

// Words that look proper (capitalized) but aren't useful entities.
const NON_ENTITY = new Set([
  'What', 'Why', 'How', 'Who', 'Whom', 'Which', 'Does', 'Do', 'Did', 'Is', 'Are',
  'Was', 'Were', 'The', 'A', 'An', 'And', 'But', 'So', 'Then', 'Explain', 'Tell',
  'Me', 'About', 'In', 'Of', 'To', 'He', 'She', 'It', 'They', 'There', 'Their',
  'His', 'Her', 'Please', 'Can', 'Could', 'Would', 'Should',
]);

// Function words that carry no retrieval signal on their own. Kept separate
// from NON_ENTITY (which lists capitalised question words) because keyword
// extraction also needs the lowercase glue words dropped.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'so', 'then', 'than', 'if', 'in', 'on',
  'at', 'to', 'of', 'for', 'with', 'by', 'from', 'as', 'is', 'are', 'was',
  'were', 'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had',
  'not', 'no', 'yes', 'this', 'that', 'these', 'those', 'it', 'its', 'he',
  'him', 'his', 'she', 'her', 'hers', 'they', 'them', 'their', 'we', 'our',
  'you', 'your', 'i', 'me', 'my', 'who', 'whom', 'what', 'when', 'where',
  'which', 'why', 'how', 'about', 'into', 'over', 'under', 'say', 'says',
  'said', 'tell', 'tells', 'please', 'can', 'could', 'would', 'should', 'will',
  'shall', 'may', 'might', 'must',
]);

function extractProperNouns(text) {
  const seen = [];
  for (const m of String(text).matchAll(/\b([A-Z][a-zA-Z’-]{1,})\b/g)) {
    const w = m[1];
    if (!NON_ENTITY.has(w) && !seen.includes(w)) seen.push(w);
  }
  return seen;
}

// Deterministic keyword set for recall-friendly full-text search: proper nouns
// first (they are the most discriminative), then any remaining content words.
// Each word is a raw surface form; the caller quotes it into a tsquery phrase.
function extractKeywords(text, properNouns) {
  const seen = [];
  const push = (raw) => {
    const word = String(raw).replace(/[“”"]/g, '').trim();
    const key = word.toLowerCase();
    if (word.length < 3 || STOPWORDS.has(key)) return;
    if (seen.some((s) => s === key)) return;
    seen.push(key);
  };
  for (const w of properNouns) push(w);
  for (const w of String(text).split(/[^\p{L}\p{N}'’-]+/u)) push(w);
  return seen.slice(0, 6);
}

function hasQuotedPhrase(text) {
  return /[“"].+?[”"]/.test(String(text));
}

export function understandQuery({ message, recentMessages = [] }) {
  const original = String(message ?? '').trim();
  const words = original.length ? original.split(/\s+/).length : 0;

  // Recent user turns (oldest→newest) supply the antecedent if needed.
  const priorUser = recentMessages.filter((m) => m.role === 'user').slice(-2);
  const lastUserText = priorUser.length ? priorUser[priorUser.length - 1].content : '';

  const anaphoric = ANAPHORA.test(original);
  const isFollowUp = anaphoric && (words <= 12 || /\?$/.test(original));

  let searchQuery = original;
  let resolvedSubject = null;
  if (isFollowUp && lastUserText) {
    const subjects = extractProperNouns(lastUserText).slice(0, 2);
    if (subjects.length) {
      // Append the recovered subject verbatim — no facts invented, just the noun.
      resolvedSubject = subjects.join(' ');
      searchQuery = `${original} — ${resolvedSubject}`;
    }
    // If no subject can be recovered we DO NOT guess (uncertainty preserved).
  }

  const terms = extractProperNouns(original);
  // Keywords read the (possibly subject-resolved) searchQuery so follow-ups keep
  // the recovered name; proper nouns come first for discriminative ranking.
  const keywords = extractKeywords(searchQuery, extractProperNouns(searchQuery));
  const lexicalNeeded = terms.length > 0 || hasQuotedPhrase(original) || /\b(?:quote|passage|chapter)\b/i.test(original);

  return {
    original,
    searchQuery,
    isFollowUp,
    resolvedSubject,
    terms,
    keywords,
    lexicalNeeded,
    semanticNeeded: true, // semantic retrieval is always appropriate
    contextMessageLimit: ragConfig.contextMessageLimit,
  };
}
