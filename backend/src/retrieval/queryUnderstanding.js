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
  // Devanagari glue: pronouns, postpositions and the copula. Without these a
  // Hindi question is all filler-words and punctuation, and looks empty.
  'यह', 'ये', 'वह', 'वो', 'है', 'हैं', 'था', 'थी', 'में', 'का', 'की', 'के',
  'को', 'से', 'पर', 'भी', 'एक', 'किस', 'कौन', 'क्या', 'क्यों', 'जब', 'कहाँ',
  'नहीं', 'हुआ', 'लिए', 'सब', 'कुछ',
]);

// Word splitter. Devanagari vowel signs are combining marks (\p{M}) rather than
// letters, so a class of \p{L}\p{N} alone shreds "किताब" into single characters —
// which made every Hindi question look like it had nothing searchable in it.
const WORD_SEP = /[^\p{L}\p{M}\p{N}'’-]+/u;

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
  for (const w of String(text).split(WORD_SEP)) push(w);
  return seen.slice(0, 6);
}

function hasQuotedPhrase(text) {
  return /[“"].+?[”"]/.test(String(text));
}

// ---------------------------------------------------------------------------
// Conversational turns vs book questions
//
// "chal bhai thik hindi me bta", "ok", "aage badhao" are instructions about the
// CONVERSATION, not questions about the book. Sending them to full-text search
// produced the absurd reply "I could not find the words chal, bhai, thik", so a
// turn with nothing searchable in it is now recognised before retrieval runs.
//
// FILLER is deliberately the *only* filter, and it holds nothing that could
// plausibly be a book topic: greetings, acknowledgements, Hindi/Hinglish
// grammar words, and words that ask for the SAME answer in another form. A
// made-up name ("drmiti") or a theme ("faith") always survives and is searched.
const FILLER = new Set([
  // greetings / acknowledgements / pure reaction
  'ok', 'okay', 'okey', 'k', 'yes', 'yeah', 'yep', 'nope', 'hmm', 'hm', 'oh',
  'ah', 'wow', 'oops', 'thanks', 'thank', 'thx', 'ty', 'welcome', 'pls', 'pls',
  'hello', 'helo', 'hii', 'hlo', 'hey', 'yo', 'sup', 'bye', 'goodbye', 'lol',
  'lmao', 'brb', 'idk', 'ikr', 'haha', 'hehe', 'yay', 'cool', 'wow',
  // Hindi / Hinglish grammar and reaction (Roman script)
  'hai', 'hain', 'ho', 'hua', 'hoga', 'huwa', 'nahi', 'nahin', 'nhi', 'haan',
  'kya', 'kyu', 'kyon', 'kyunki', 'kisko', 'kisne', 'kaise', 'kaisa', 'aisa',
  'waisa', 'yeh', 'ye', 'woh', 'vo', 'wah', 'mujhe', 'muje', 'mujhko', 'tumhe',
  'tum', 'aap', 'apko', 'hume', 'ham', 'mera', 'meri', 'teri', 'uska', 'iska',
  'apna', 'wala', 'wale', 'wali', 'ka', 'ki', 'ke', 'ko', 'se', 'me', 'mein',
  'main', 'par', 'pe', 'aur', 'ar', 'ya', 'to', 'bhi', 'ek', 'do', 'teen',
  'bas', 'ab', 'abhi', 'pehle', 'pahle', 'baad', 'bina', 'tak', 'liye', 'kar',
  'karo', 'kariya', 'karta', 'karti', 'kiya', 'kr', 'krd', 'karde', 'de',
  'dena', 'lena', 'le', 'sun', 'suno', 'dekh', 'dekho', 'samjh', 'samjha',
  'samjhaya', 'samajh', 'smj', 'acha', 'achha', 'accha', 'achhe', 'theek',
  'thik', 'tik', 'sahi', 'sahee', 'galat', 'zara', 'jara', 'thoda', 'thora',
  'zyada', 'jyada', 'bahut', 'bhut', 'bohot', 'kam', 'poora', 'pura', 'adhoora',
  'matt', 'mat', 'bhen', 'behen', 'bhaiya', 'dost', 'yaar', 'yar', 'bhai',
  'bhia', 'chal', 'chalo', 'chl', 'bhai',
  // asking for the same answer in another form
  'bata', 'batao', 'batado', 'batade', 'btana', 'bta', 'bto', 'bol', 'bolo',
  'bolen', 'dobara', 'dubara', 'phir', 'fir', 'repeat', 'rephrase', 'again',
  're', 'age', 'aage', 'jaari', 'zari', 'rakh', 'rakho', 'continue', 'badhao',
  'badhaao', 'badao',
  'simple', 'simplify', 'easily', 'shorter', 'clear', 'clearly', 'proper',
  'properly', 'detail', 'detailed', 'details', 'example', 'examples',
  'hindi', 'english', 'urdu', 'bhasha', 'boli', 'translate', 'translation',
  'anuvaad', 'matlab', 'language',
  // verbs that ask the assistant to DO something, not for a book topic
  'explain', 'describe', 'elaborate', 'summarize', 'summary', 'answer',
  'reply', 'write', 'kindly', 'question', 'doubt', 'topic',
]);

// Words that ask for the PREVIOUS answer in another form. They only make sense
// as an instruction about the conversation, so a meta turn holding one of them
// re-serves the last real book question instead of getting a chat reply.
const FORM_REQUEST = new Set([
  'bata', 'batao', 'batado', 'batade', 'btana', 'bta', 'bto', 'bol', 'bolo', 'bolen',
  'dobara', 'dubara', 'phir', 'fir', 'repeat', 'rephrase', 'again', 're',
  'age', 'aage', 'jaari', 'zari', 'continue', 'next', 'badhao', 'badhaao', 'badao', 'rakh', 'rakho',
  'detail', 'detailed', 'details', 'elaborate', 'expand', 'zyada', 'jyada', 'bahut', 'bhut',
  'bohot', 'poora', 'pura', 'thoda', 'thora', 'zara', 'jara', 'example', 'examples', 'udahar',
  'simple', 'simplify', 'easily', 'asani', 'clear', 'clearly', 'proper', 'properly',
  'short', 'shorter', 'chhota', 'chota', 'concise', 'matlab',
]);

// Small talk. The turn must contain at least one CORE greeting/acknowledgement
// word and every other word must be small-talk glue, so "what is good?" keeps
// its 'good' as a topic while "good morning" and "hi bhai" are recognised as
// talk aimed at the assistant.
const GREET_CORE = new Set([
  'hi', 'hii', 'hiii', 'hlo', 'helo', 'hello', 'halllo', 'helllo', 'halo', 'hey', 'heya',
  'yo', 'sup', 'namaste', 'namaskar', 'salaam', 'salam', 'adab', 'ok', 'okay', 'okey', 'kk',
  'thx', 'ty', 'thanks', 'bye', 'goodbye', 'tc', 'gm', 'gn', 'haha', 'hehe', 'lol', 'yay',
  'oops', 'yep', 'yeah', 'hmm', 'hm', 'oh', 'ah', 'morning', 'afternoon', 'evening', 'night',
  'kaise', 'kaisa', 'badiya', 'badriya', 'vadima', 'chal', 'chalo', 'chl', 'greet',
]);
const GREET_GLUE = new Set([
  'good', 'how', 'are', 'you', 'u', 'it', 's', 'doing', 'goes', 'there', 'nice', 'cool',
  'awesome', 'wow', 'friend', 'dost', 'yaar', 'bhai', 'bhia', 'bhaiya', 'mate', 'all', 'sab',
  'aap', 'tum', 'who', 'r', 'am', 'kaun', 'today', 'day', 'theek', 'thik', 'sahi', 'sahee', 'ho',
]);

function isSmallTalk(text) {
  const tokens = String(text).toLowerCase().split(WORD_SEP).filter(Boolean);
  if (!tokens.length) return false;
  return tokens.some((t) => GREET_CORE.has(t))
    && tokens.every((t) => GREET_CORE.has(t) || GREET_GLUE.has(t) || STOPWORDS.has(t));
}

const DEVANAGARI = /[\u0900-\u097F]/;

// Words that only occur in Hindi/Hinglish speech. Two of them in one message is
// enough to conclude the user is not writing English.
const HINGLISH_MARKERS = new Set([
  'hai', 'hain', 'nahi', 'nahin', 'nhi', 'kya', 'kyu', 'kyon', 'kaun', 'kaise',
  'kaisa', 'kab', 'kaha', 'kahan', 'mujhe', 'tumhe', 'aap', 'bhai', 'yaar',
  'batao', 'bata', 'bta', 'bolo', 'bol', 'karo', 'kar', 'kr', 'acha', 'achha',
  'accha', 'achhe', 'theek', 'thik', 'sahi', 'samjha', 'samajh', 'dobara',
  'dubara', 'phir', 'bahut', 'zyada', 'jyada', 'thoda', 'zara', 'matlab',
  'bhasha', 'hindi', 'hinglish', 'wala', 'wali', 'aisa', 'waisa', 'yeh', 'woh',
  'meri', 'tera', 'apna', 'bas', 'abhi', 'nahin', 'haan', 'kyunki', 'chal',
  // asking what the book is about, in Roman-script Hindi
  'kis', 'baare', 'kitab', 'kitaab', 'poori', 'kahani', 'kahaani', 'saar',
]);

// Which script/register the user actually typed in. Answers must come back in
// the same language — a Hindi question should not be answered only in English.
// `minHinglishWords` is relaxed for small talk: a greeting carrying even one
// Hindi word ("hi bhai") is casual Hinglish, while one stray Hindi word inside a
// real English book question must not flip the whole answer's register.
export function detectLanguage(text, { minHinglishWords = 2 } = {}) {
  const s = String(text ?? '');
  if (DEVANAGARI.test(s)) return 'hi';
  const words = s.toLowerCase().split(WORD_SEP).filter(Boolean);
  const hindiWords = words.filter((w) => HINGLISH_MARKERS.has(w)).length;
  // Two markers is the line between "what does Ivan say" and "bhai ye kya hai".
  return hindiWords >= minHinglishWords ? 'hinglish' : 'en';
}

// Remove the conversational glue from an already-stopword-filtered keyword set.
// What survives is what the user actually wants found in the book.
export function contentKeywords(keywords = []) {
  return keywords.filter((k) => !FILLER.has(String(k).toLowerCase()));
}

// "hindi me bta" and "translate this to english" both name a target language,
// and the target — not the script they typed it in — is what the answer should
// use. A Roman-script "hindi me bta" means Hindi in the letters the user is
// already typing with; only Devanagari in the request asks for Devanagari back.
function requestedLanguage(text) {
  if (/हिन्दी|हिंदी/.test(text)) return 'hi';
  // The cue has to sit next to the language word, so a book that merely
  // mentions "Hindi" as a topic is not read as a formatting instruction.
  const cue = /\b(?:in|into|to|me|mein|ma|ka|ki|ke)\s+(hindi|hinglish|english|urdu|angrezi?)\b|\b(hindi|hinglish|english|urdu|angrezi?)\s+(?:me|mein|ma)\b/i.exec(text);
  if (!cue) return null;
  const lang = (cue[1] || cue[2]).toLowerCase();
  if (lang === 'english' || lang.startsWith('angrez')) return 'en';
  // A Roman-script "hindi me bta" wants Roman-script Hindi back — the letters
  // the user is already typing with. Devanagari was handled above.
  return 'hinglish';
}

// ---------------------------------------------------------------------------
// Whole-book questions vs questions about one passage
//
// "what is the story of this book?" is not a lookup — no single page answers it.
// Retrieving the 5 chunks nearest that sentence returns five isolated
// dialogues, and the model correctly reported that they contain no plot
// summary. Such questions instead get a sample spread across the whole book, so
// this detector decides the RETRIEVAL SHAPE (never what may be claimed).
//
// A book word ("book", "novel", "kitab") has to be the thing being asked about,
// or the ask has to be an explicit summary — so "what does Ivan say about God"
// stays a passage question even though it contains "about".
const BOOK_WORD = /\b(book|books|novel|text|volume|read)\b|kitab|kitaab|granth|किताब|कتاب|ग्रंथ/i;
const GLOBAL_ASK =
  /\b(story|plot|summari[sz]e|summary|overview|recap|synopsis|main|central|core|overall|whole|entire|full|complete|beginning|ending|theme|message|lesson|takeaway|genre|kind|type|point|idea|about|kis\s+baare|kis\s+bart|kahani|kahaani|saar|ansh|baat)\b|कहानी|सारांश|बारे|पूरी|सारा/i;

function isWholeBookQuestion(text) {
  const s = String(text ?? '');
  if (/\b(summari[sz]e|summary|overview|recap|synopsis|tl;?dr|poori\s+(kitab|kitaab|book)|saar\s+(karo|batao?)|kahani\s+(batao|btao|kya)|kis\s+baare)\b/i.test(s)) return true;
  return BOOK_WORD.test(s) && GLOBAL_ASK.test(s);
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
  const searchable = contentKeywords(keywords);
  // An explicit "in hindi" beats the script the message happens to be typed in.
  const requested = requestedLanguage(original);
  const language = requested ?? detectLanguage(original);

  // A turn with nothing searchable in it is a conversation about the
  // conversation, not a question to the book. Retrieval must not run on it —
  // that is what produced "I could not find the words chal, bhai, thik".
  // Small talk is meta even when a greeting word survives the filler filter
  // ("good morning"), because it was never aimed at the book either.
  const smallTalk = isSmallTalk(original);
  const kind = smallTalk || searchable.length === 0 ? 'meta' : 'book';
  // What a meta turn actually asks for: another language, another form of the
  // previous answer, or simply a reply as a conversation would give one.
  const intent = kind === 'meta'
    ? (requested || /hindi|english|urdu|bhasha|translate|translation|anuvaad|matlab|language/i.test(original)
        ? 'language'
        : original.toLowerCase().split(WORD_SEP).some((w) => FORM_REQUEST.has(w))
          ? 'form'
          : 'social')
    : null;

  return {
    original,
    searchQuery,
    isFollowUp,
    resolvedSubject,
    terms,
    keywords: searchable,
    contentKeywords: searchable,
    lexicalNeeded: searchable.length > 0 || terms.length > 0 || hasQuotedPhrase(original) || /\b(?:quote|passage|chapter)\b/i.test(original),
    semanticNeeded: kind === 'book', // a meta turn has nothing to embed
    kind,
    intent,
    // 'whole_book' asks about the book as a single thing; 'passage' asks about
    // something at a particular place in it. Decides how wide to retrieve.
    scope: kind === 'book' && isWholeBookQuestion(original) ? 'whole_book' : 'passage',
    language,
    contextMessageLimit: ragConfig.contextMessageLimit,
  };
}
