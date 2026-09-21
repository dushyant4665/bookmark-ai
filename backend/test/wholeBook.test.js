import { test } from 'node:test';
import assert from 'node:assert/strict';

import { understandQuery } from '../src/retrieval/queryUnderstanding.js';
import { spreadRetrieval } from '../src/retrieval/spreadRetrieval.js';
import { researchQuery } from '../src/services/researchService.js';
import { buildSystemPrompt } from '../src/rag/generation.js';
import { ragConfig } from '../src/config/rag.js';

// "What is the story of this book?" is not a lookup — five passages from one
// region of the book cannot summarise it, and the model kept answering "the
// passages provided do not include a summary". Those questions are now detected
// and answered from one real chunk in each slice of the book, in reading order.

const OVERVIEW = [
  'what is the story of this book ?',
  'What is this book really about?',
  'summarize this book',
  'give me a short summary',
  'ye book kis baare me hai',
  'poori kitab ka kahani batao',
  'यह किताब किस बारे में है?',
];

for (const message of OVERVIEW) {
  test(`whole-book question is scoped as a book question: "${message}"`, () => {
    const u = understandQuery({ message, recentMessages: [] });
    assert.equal(u.kind, 'book', 'an overview ask must never be searched as small talk');
    assert.equal(u.scope, 'whole_book');
  });
}

const TARGETED = [
  'What does Ivan say about God and the suffering of children?',
  'what happens in the end of the novel?',
  'tell me about the main characters',
  'does the book mention Napoleon?',
  'which passages state it most directly?',
];

for (const message of TARGETED) {
  test(`targeted question keeps passage scope: "${message}"`, () => {
    assert.equal(understandQuery({ message, recentMessages: [] }).scope, 'passage');
  });
}

test('a Devanagari question keeps its words instead of shredding into letters', () => {
  const u = understandQuery({ message: 'यह किताब किस बारे में है?', recentMessages: [] });
  assert.ok(u.keywords.includes('किताब'), `got ${JSON.stringify(u.keywords)}`);
  assert.ok(u.keywords.includes('बारे'));
  assert.ok(!u.keywords.includes('क'), 'a combining vowel sign is not a word');
});

test('the whole-book prompt forbids commenting on the sample itself', () => {
  const p = buildSystemPrompt({ wholeBook: true });
  assert.match(p, /BOOK AS A WHOLE/);
  assert.match(p, /Do NOT describe or comment on the sample/);
  assert.match(p, /half-answer is not a question you refuse/);
  assert.match(p, /Answer FIRST, qualify SECOND/);
});

const chunkRow = (over) => ({
  id: 'x', book_id: 'b', edition_id: 'e', book_source_id: 'src-1', page_id: 'p',
  chunk_uid: 'u', page_start: 1, page_end: 1, chapter: null, source_text: 'text',
  search_text: 'text', spans: [], coordinates_available: false, ...over,
});

test('spread retrieval asks PostgreSQL for one chunk per slice, clamped', async () => {
  const calls = [];
  const rows = [chunkRow({ id: 'a', page_start: 3 }), chunkRow({ id: 'b', page_start: 400 })];
  const candidates = await spreadRetrieval({
    bookId: 'b', editionId: 'e', sourceId: 'src-1', tiles: 99,
    runQuery: async (sql, params) => {
      calls.push({ sql: sql.replace(/\s+/g, ' '), params });
      return { rows };
    },
  });
  const [{ sql, params }] = calls;
  assert.ok(sql.includes('ntile($1::int)'), 'the slice count is a parameter, not interpolated');
  assert.equal(params[0], 12, 'tiles are clamped so one query cannot ask for 99 slices');
  assert.ok(sql.includes('c.book_source_id = $5'), 'only the indexed source is sampled');
  assert.deepEqual(candidates.map((c) => [c.chunkId, c.retrieval.spreadRank]), [['a', 1], ['b', 2]]);
});

async function runWholeBook({ spreadRows, message = 'what is the story of this book?' }) {
  const events = [];
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message },
    {
      runQuery: async (sql) => {
        const s = sql.replace(/\s+/g, ' ');
        if (s.includes('FROM book_editions')) {
          return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED', book_title: 'B', edition_label: 'E' }] };
        }
        if (s.includes('FROM conversations WHERE id')) {
          return { rows: [{ id: 'c', user_id: 'u', book_id: 'b', edition_id: 'e' }] };
        }
        if (s.includes('FROM conversation_messages') && s.includes('ORDER BY created_at')) return { rows: [] };
        if (s.includes('ntile(')) return { rows: spreadRows };
        // Both scored legs find nothing: the sample is the only signal.
        if (s.includes('embedding <=>') || s.includes('search_tsv')) return { rows: [] };
        if (s.includes('FROM book_pages')) return { rows: [] };
        return { rows: [] };
      },
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      groq: async () => JSON.stringify({ answer: 'It follows three brothers.', evidenceIds: ['e1'], confidence: 'supported' }),
      emit: (type, data) => events.push({ type, data }),
    }
  );
  return { res, events };
}

test('a whole-book question is answered from the sample even with no scored hits', async () => {
  const { res, events } = await runWholeBook({
    spreadRows: [
      chunkRow({ id: 'a', page_start: 12, source_text: 'The family history opens.' }),
      chunkRow({ id: 'b', page_start: 130, source_text: 'The elder teaches love.' }),
      chunkRow({ id: 'c', page_start: 585, page_end: 590, source_text: 'The trial ends.' }),
    ],
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.debug.scope, 'whole_book');
  assert.equal(events.find((e) => e.type === 'reranking').data.provider, 'whole_book_sample');
  assert.equal(res.citations.length, 1, 'citations resolve to real DB rows, never invented ones');
  assert.equal(res.citations[0].page, 12);
});

test('a passage question never takes the sample path', async () => {
  const { res } = await runWholeBook({
    spreadRows: [
      chunkRow({ id: 'a', page_start: 12 }),
      chunkRow({ id: 'b', page_start: 130 }),
    ],
    message: 'What does Ivan say about God?',
  });
  assert.equal(res.debug.scope, 'passage');
  assert.equal(res.debug.counts.spread, 0, 'no sample is fetched for a lookup question');
});
