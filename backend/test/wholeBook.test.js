import { test } from 'node:test';
import assert from 'node:assert/strict';

import { understandQuery } from '../src/retrieval/queryUnderstanding.js';
import { spreadRetrieval } from '../src/retrieval/spreadRetrieval.js';
import { researchQuery } from '../src/services/researchService.js';
import {
  CITATION_DELIM,
  buildSystemPrompt,
  evidenceMentions,
  refusedDespiteEvidence,
} from '../src/rag/generation.js';
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

// ============================================================================
// The shrug is not a stable output. The same passages get answered on one call
// and refused on the next, and a refusal in front of real evidence is the one
// reply the user should not see. So the pipeline asks once more, pointedly.
// ============================================================================

function refuseRun({
  answers,
  message = 'What does Ivan say about God?',
  rows = [
    chunkRow({ id: 'a', page_start: 199, source_text: 'Ivan on the tortured baby.' }),
    chunkRow({ id: 'b', page_start: 193, source_text: 'Ivan on Christ-like love.' }),
  ],
}) {
  const events = [];
  const calls = [];
  const run = async (sql) => {
    const s = sql.replace(/\s+/g, ' ');
    if (s.includes('FROM book_editions')) {
      return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED', book_title: 'B', edition_label: 'E' }] };
    }
    if (s.includes('FROM conversations WHERE id')) {
      return { rows: [{ id: 'c', user_id: 'u', book_id: 'b', edition_id: 'e' }] };
    }
    if (s.includes('FROM conversation_messages') && s.includes('ORDER BY created_at')) return { rows: [] };
    if (s.includes('embedding <=>')) return { rows };
    if (s.includes('search_tsv')) return { rows: [] };
    return { rows: [] };
  };
  const p = researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message },
    {
      runQuery: run,
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      groq: async (messages) => {
        calls.push(messages[0].content);
        return answers[calls.length - 1];
      },
      emit: (type, data) => events.push({ type, data }),
    }
  );
  return { p, events, calls };
}

const SHRUG = JSON.stringify({ answer: 'The passages do not say.', evidenceIds: [], confidence: 'insufficient' });
const REAL = JSON.stringify({ answer: 'Ivan returns the ticket.', evidenceIds: ['e1'], confidence: 'supported' });

test('a shrug in front of real evidence is retried once, with the nudge', async () => {
  const { p, events, calls } = refuseRun({ answers: [SHRUG, REAL] });
  const res = await p;
  assert.equal(calls.length, 2, 'it asked again');
  assert.match(calls[1], /second attempt with the SAME excerpts/);
  assert.ok(!/second attempt/.test(calls[0]), 'the first call is the plain prompt');
  assert.equal(res.confidence, 'supported');
  assert.equal(res.answer, 'Ivan returns the ticket.');
  assert.equal(res.citations.length, 1);
  assert.ok(events.some((e) => e.type === 'answer_reset'), 'the UI is told to replace the refused text');
});

test('a refusal with no evidence in hand is not treated as a shrug', () => {  const shrugged = { confidence: 'insufficient', evidenceIds: [] };
  assert.equal(refusedDespiteEvidence(shrugged, []), false, 'nothing was retrieved, so nothing to re-ask');
  assert.equal(refusedDespiteEvidence(shrugged, [{ evidenceId: 'e1' }]), true);
  assert.equal(
    refusedDespiteEvidence({ confidence: 'insufficient', evidenceIds: ['e1'] }, [{ evidenceId: 'e1' }]),
    false,
    'it cited something, so it did answer'
  );
});

test('the retry happens only once, so a real miss still ends honestly', async () => {
  const { p, calls, events } = refuseRun({ answers: [SHRUG, SHRUG, SHRUG] });
  const res = await p;
  assert.equal(calls.length, 2, 'one second attempt, never a loop');
  assert.equal(res.confidence, 'insufficient');
  assert.equal(res.answer, 'The passages do not say.');
  assert.equal(events.filter((e) => e.type === 'answer_reset').length, 1);
});


// The route users actually hit streams its answer, so the retry has to work
// there too: the refused text is replaced by the second attempt's real deltas.
const STREAM_SHRUG = [
  'Nothing here answers that. ',
  `\n${CITATION_DELIM}\n{"evidenceIds":[],"confidence":"insufficient"}`,
];
const STREAM_ANSWER = [
  'Ivan answers ',
  'by returning the ticket. ',
  `\n${CITATION_DELIM}\n{"evidenceIds":["e1"],"confidence":"supported"}`,
];

test('a streamed shrug is retried and the retried text replaces it', async () => {
  const events = [];
  const attempts = [STREAM_SHRUG, STREAM_ANSWER];
  let call = 0;
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What does Ivan say about God?' },
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
        if (s.includes('embedding <=>')) {
          return {
            rows: [
              chunkRow({ id: 'a', page_start: 199, distance: 0.2, source_text: 'Ivan on the tortured baby.' }),
              chunkRow({ id: 'b', page_start: 193, distance: 0.4, source_text: 'Ivan on Christ-like love.' }),
            ],
          };
        }
        if (s.includes('search_tsv') || s.includes('FROM book_pages')) return { rows: [] };
        return { rows: [] };
      },
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      stream: async function* () { for (const part of attempts[call++]) yield part; },
      emit: (type, data) => events.push({ type, data }),
    }
  );
  const types = events.map((e) => e.type);
  assert.equal(call, 2, 'the stream was run again');
  assert.equal(types.filter((t) => t === 'answer_reset').length, 1);
  assert.ok(
    types.indexOf('answer_reset') < types.lastIndexOf('answer_chunk'),
    'the replacement text arrives after the reset'
  );
  assert.equal(res.answer, 'Ivan answers by returning the ticket.');
  assert.equal(res.confidence, 'supported');
  assert.equal(res.citations.length, 1);
});

// A second call is only worth paying for when the passages contain what the
// question asked about. An off-book question stays the honest refusal it is.
test('a question the passages never mention is refused once, not retried', async () => {
  const { p, calls, events } = refuseRun({ answers: [SHRUG, SHRUG], message: 'who won the world cup?' });
  const res = await p;
  assert.equal(calls.length, 1, 'no keyword of the question appears in the evidence');
  assert.equal(events.filter((e) => e.type === 'answer_reset').length, 0);
  assert.equal(res.confidence, 'insufficient');
});

test('evidenceMentions matches the question\'s own words, case-insensitively', () => {
  const evidence = [{ text: 'Ivan on the tortured baby.' }];
  assert.equal(evidenceMentions(evidence, ['ivan', 'god']), true);
  assert.equal(evidenceMentions(evidence, ['world', 'cup']), false);
  assert.equal(evidenceMentions(evidence, []), true, 'nothing to match is not a reason to refuse a retry');
  assert.equal(
    evidenceMentions([{ text: 'A woman wept by the road.' }], ['won']),
    false,
    'a keyword buried inside another word is not a mention'
  );
});
