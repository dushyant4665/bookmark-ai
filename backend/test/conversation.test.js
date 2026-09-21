import { test } from 'node:test';
import assert from 'node:assert/strict';

import { understandQuery } from '../src/retrieval/queryUnderstanding.js';
import { rowToCandidate } from '../src/retrieval/evidence.js';
import { researchQuery } from '../src/services/researchService.js';
import { languageRule, plainLanguageRule } from '../src/rag/generation.js';
import { ragConfig } from '../src/config/rag.js';

// Conversational turns must never be searched as book questions.
//
// The bug this locks down: "chal bhai thik hindi me bta" was sent to full-text
// search and answered with "I could not find the words chal, bhai, thik" — in
// English. Such a turn asks for a different FORM of the previous answer, so it
// is re-served against the last real book question, in the user's language.

function makeRow(overrides = {}) {
  return {
    id: 'chunk-x',
    book_id: 'book-1',
    edition_id: 'ed-1',
    book_source_id: 'src-1',
    page_id: 'page-1',
    chunk_uid: 'uid-x',
    page_start: 1,
    page_end: 1,
    chapter: null,
    source_text: 'text',
    search_text: 'text',
    spans: [],
    coordinates_available: false,
    ...overrides,
  };
}

const PRIOR_QUESTION = 'What does Ivan say about God?';

// A fake DB that also records which retrieval queries actually ran.
function harness({ messages = [], vectorRows = [], lexicalRows = [] }) {
  const seen = { vectorSql: [], lexicalSql: [], embedTexts: [], inserts: [] };
  const runQuery = async (sql, params = []) => {
    if (sql.includes('FROM book_editions')) {
      return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED', book_title: 'The Brothers Karamazov', edition_label: 'E' }] };
    }
    if (sql.includes('FROM conversations WHERE id')) {
      return { rows: [{ id: 'c', user_id: 'u', book_id: 'b', edition_id: 'e' }] };
    }
    if (sql.includes('FROM conversation_messages') && sql.includes('ORDER BY created_at')) {
      return { rows: messages };
    }
    if (sql.includes('embedding <=>')) {
      seen.vectorSql.push(params);
      return { rows: vectorRows };
    }
    if (sql.includes('search_tsv')) {
      seen.lexicalSql.push(params);
      return { rows: lexicalRows };
    }
    if (/INSERT INTO conversation_messages/.test(sql)) seen.inserts.push(params);
    return { rows: [] };
  };
  const provider = {
    name: 'jina',
    embedBatch: async (texts) => {
      seen.embedTexts.push(...texts);
      return texts.map(() => new Array(ragConfig.embeddingDim).fill(0.1));
    },
  };
  return { seen, runQuery, makeProvider: () => provider };
}

function evidenceRows() {
  return {
    vectorRows: [makeRow({ id: 'a', distance: 0.2, page_start: 10, source_text: 'Ivan: I reject God.' })],
    lexicalRows: [makeRow({ id: 'a', rank: 0.5, page_start: 10, source_text: 'Ivan: I reject God.' })],
  };
}

const groundedGroq = async () =>
  JSON.stringify({ answer: 'Ivan mana karta hai.', evidenceIds: ['e1'], confidence: 'supported' });

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test('conversational Hinglish turns are recognised as meta, not book questions', () => {
  for (const text of ['chal bhai thik hindi me bta', 'ok', 'aage badhao', 'thoda detail me bta', 'hii']) {
    const u = understandQuery({ message: text, recentMessages: [] });
    assert.equal(u.kind, 'meta', text);
    assert.deepEqual(u.keywords, [], text);
  }
});

test('a real question is still a book question, with its content words kept', () => {
  const u = understandQuery({ message: PRIOR_QUESTION, recentMessages: [] });
  assert.equal(u.kind, 'book');
  assert.ok(u.keywords.includes('ivan') && u.keywords.includes('god'));
  assert.ok(!u.keywords.some((k) => ['what', 'does', 'say', 'about'].includes(k)));
});

test('a made-up or unusual term is never dropped as filler', () => {
  const u = understandQuery({ message: 'who is drmiti?', recentMessages: [] });
  assert.equal(u.kind, 'book');
  assert.ok(u.keywords.includes('drmiti'));
});

test("a book question that merely mentions 'Hindi' is not a formatting request", () => {
  const u = understandQuery({ message: 'What does the book say about the Hindi language?', recentMessages: [] });
  assert.equal(u.kind, 'book');
  assert.equal(u.language, 'en');
});

test('answers follow the language the user actually used', () => {
  assert.equal(understandQuery({ message: PRIOR_QUESTION, recentMessages: [] }).language, 'en');
  assert.equal(understandQuery({ message: 'ye kitab kya kehti hai', recentMessages: [] }).language, 'hinglish');
  assert.equal(understandQuery({ message: 'यह किताब क्या कहती है', recentMessages: [] }).language, 'hi');
  // An explicit target language wins over the script it was typed in.
  assert.equal(understandQuery({ message: 'translate this in english', recentMessages: [] }).language, 'en');
  assert.equal(understandQuery({ message: 'hindi me bta', recentMessages: [] }).language, 'hinglish');
  assert.equal(understandQuery({ message: 'हिंदी में बताओ', recentMessages: [] }).language, 'hi');
});

test('language rules ask for the user register and forbid translating evidence', () => {
  assert.match(languageRule('hi'), /Devanagari/);
  assert.match(languageRule('hinglish'), /Hinglish/);
  assert.match(languageRule('en'), /the language the user wrote in/);
  for (const l of ['hi', 'hinglish', 'en']) assert.match(languageRule(l), /never translate|Never translate/);
  assert.match(plainLanguageRule('hinglish'), /Roman letters/);
});

// ---------------------------------------------------------------------------
// A meta turn re-serves the previous real question
// ---------------------------------------------------------------------------

test('a Hinglish "bta in hindi" answers the previous question, never searches the filler', async () => {
  const { seen, runQuery, makeProvider } = harness({
    messages: [
      { role: 'user', content: PRIOR_QUESTION },
      { role: 'assistant', content: 'Ivan rejects God because of the suffering of children.' },
    ],
    ...evidenceRows(),
  });
  let prompt = null;
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'chal bhai thik hindi me bta' },
    {
      runQuery,
      makeProvider,
      reranker: null,
      groq: async (messages) => {
        prompt = messages;
        return groundedGroq();
      },
    }
  );

  // Retrieval ran on the real question, not on "chal bhai thik bta".
  assert.equal(seen.embedTexts.length, 1);
  assert.equal(seen.embedTexts[0], PRIOR_QUESTION);
  assert.ok(!/chal|bhai|thik|bta/.test(seen.lexicalSql.flat().join(' ')), 'filler must not reach full-text search');
  assert.ok(prompt[1].content.includes(`QUESTION: ${PRIOR_QUESTION}`));
  // And the answer is demanded in the user's own register.
  assert.match(prompt[0].content, /Hinglish/);
  assert.ok(!/could not find the words/i.test(res.answer));

  // Grounding is untouched: a real citation still resolves to a real page.
  assert.equal(res.status, 'ok');
  assert.equal(res.citations.length, 1);
  assert.equal(res.citations[0].page, 10);
  assert.equal(res.citations[0].text, 'Ivan: I reject God.');
  assert.equal(seen.inserts[0][1], 'chal bhai thik hindi me bta', 'the user turn is stored as typed');
});

test('a form request carries the user’s exact words to the model', async () => {
  const { runQuery, makeProvider } = harness({
    messages: [{ role: 'user', content: PRIOR_QUESTION }, { role: 'assistant', content: 'A short answer.' }],
    ...evidenceRows(),
  });
  let prompt = null;
  await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'thoda detail me bta' },
    {
      runQuery,
      makeProvider,
      reranker: null,
      groq: async (messages) => {
        prompt = messages;
        return groundedGroq();
      },
    }
  );
  assert.match(prompt[0].content, /thoda detail me bta/);
  assert.match(prompt[0].content, /go into more detail/);
  // The form note never loosens the grounding contract.
  assert.match(prompt[0].content, /ONLY the supplied evidence/);
});

test('a normal English question is unaffected by meta-turn handling', async () => {
  const { seen, runQuery, makeProvider } = harness({ messages: [], ...evidenceRows() });
  let prompt = null;
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: PRIOR_QUESTION },
    {
      runQuery,
      makeProvider,
      reranker: null,
      groq: async (messages) => {
        prompt = messages;
        return groundedGroq();
      },
    }
  );
  assert.equal(seen.embedTexts[0], PRIOR_QUESTION);
  assert.ok(!/The user wrote in (Hinglish|Hindi)/.test(prompt[0].content), 'no language switch was invented');
  assert.ok(!/change of form/.test(prompt[0].content));
  assert.equal(res.status, 'ok');
  assert.equal(res.debug.asked, undefined);
});

// ---------------------------------------------------------------------------
// A meta turn with nothing to act on replies as conversation, claiming nothing
// ---------------------------------------------------------------------------

test('a greeting with no earlier question gets a conversational reply and zero retrieval', async () => {
  const { seen, runQuery, makeProvider } = harness({ messages: [] });
  let groqMessages = null;
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'chal bhai' },
    {
      runQuery,
      makeProvider,
      reranker: null,
      groq: async (messages, opts) => {
        groqMessages = { messages, opts };
        return 'Haan bhai, is kitab se koi sawaal poochho.';
      },
    }
  );
  assert.equal(seen.vectorSql.length, 0, 'no vector search on a conversational turn');
  assert.equal(seen.lexicalSql.length, 0, 'no full-text search on a conversational turn');
  assert.equal(seen.embedTexts.length, 0, 'nothing to embed');
  assert.equal(res.status, 'conversational');
  assert.deepEqual(res.citations, []);
  assert.deepEqual(res.evidenceIds, []);
  assert.equal(res.confidence, 'conversational');
  assert.equal(groqMessages.opts.json, false, 'a chat reply is not structured output');
  assert.match(groqMessages.messages[0].content, /Do not state, hint at or guess/);
  assert.match(groqMessages.messages[0].content, /Hinglish/);
  assert.equal(seen.inserts.length, 2, 'the exchange is still stored');
  assert.deepEqual(JSON.parse(seen.inserts[1][2]), {
    confidence: 'conversational',
    evidenceIds: [],
    reason: 'conversational_turn',
  });
});

test('a conversational turn still replies in the user language without the model', async () => {
  const { runQuery, makeProvider } = harness({ messages: [] });
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'hindi me bta' },
    {
      runQuery,
      makeProvider,
      reranker: null,
      groq: async () => {
        throw new Error('GROQ_DOWN');
      },
    }
  );
  assert.equal(res.status, 'conversational');
  assert.ok(res.answer.trim().length > 0);
  assert.match(res.answer, /kitab|sawaal/);
  // A fallback must still make no claim about the book's content.
  assert.ok(!/page \d/i.test(res.answer));
});

test('a long or model-fabricated conversational reply falls back', async () => {
  const { runQuery, makeProvider } = harness({ messages: [] });
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'ok' },
    {
      runQuery,
      makeProvider,
      reranker: null,
      groq: async () => `Dmitri says on page 40 that ${'x'.repeat(900)}`,
    }
  );
  assert.equal(res.status, 'conversational');
  assert.ok(!/Dmitri|page 40/.test(res.answer), 'an over-long reply is replaced, not shown');
});

test('conversational turns still enforce the normal validation guards', async () => {
  const runQuery = async (sql) =>
    sql.includes('FROM book_editions') ? { rows: [] } : { rows: [] };
  await assert.rejects(
    researchQuery(
      { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'ok' },
      { runQuery, makeProvider: () => ({ embedBatch: async () => [] }), groq: async () => 'x' }
    ),
    (err) => err.code === 'BOOK_EDITION_INVALID'
  );
});

test('candidates from a re-served question keep their real DB provenance', async () => {
  const row = makeRow({ id: 'z', distance: 0.1, page_start: 33, source_text: 'Alyosha believes.' });
  const cand = rowToCandidate(row);
  assert.equal(cand.pageStart, 33);
  assert.equal(cand.text, 'Alyosha believes.');
});
