import { test } from 'node:test';
import assert from 'node:assert/strict';

import { understandQuery } from '../src/retrieval/queryUnderstanding.js';
import { vectorRetrieval } from '../src/retrieval/vectorRetrieval.js';
import { lexicalRetrieval } from '../src/retrieval/lexicalRetrieval.js';
import { rrfFusion } from '../src/retrieval/hybridFusion.js';
import { rowToCandidate, toEvidence, toCitation } from '../src/retrieval/evidence.js';
import { rerank } from '../src/rag/reranker.js';
import {
  buildSystemPrompt,
  buildEvidenceBlock,
  buildMessages,
  buildStreamingMessages,
  parseStructuredAnswer,
  validateEvidenceIds,
  decideSufficiency,
  generateAnswer,
  INSUFFICIENT_MESSAGE,
  generateNoEvidenceNote,
  noEvidenceFallback,
} from '../src/rag/generation.js';
import { researchQuery } from '../src/services/researchService.js';
import { ragConfig } from '../src/config/rag.js';

// --- shared mock helpers ----------------------------------------------------

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

const candidate = (id, retrieval, extra = {}) => ({
  ...rowToCandidate(makeRow({ id, chunk_uid: `uid-${id}`, ...extra })),
  retrieval,
});

// ============================================================================
// 1. book/edition validation + 2. query validation (via researchQuery guards)
// ============================================================================

test('rejects missing message / ids with VALIDATION_ERROR', async () => {
  await assert.rejects(
    () => researchQuery({ userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: '   ' }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
  await assert.rejects(
    () => researchQuery({ userId: 'u', conversationId: '', bookId: 'b', editionId: 'e', message: 'hi' }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('rejects over-long message', async () => {
  const long = 'x'.repeat(ragConfig.maxMessageLength + 1);
  await assert.rejects(
    () => researchQuery({ userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: long }),
    (err) => err.code === 'VALIDATION_ERROR'
  );
});

test('edition must belong to the book (BOOK_EDITION_INVALID)', async () => {
  const runQuery = async (sql) => (sql.includes('FROM book_editions') ? { rows: [] } : { rows: [] });
  await assert.rejects(
    () =>
      researchQuery(
        { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'Q?' },
        { runQuery }
      ),
    (err) => err.code === 'BOOK_EDITION_INVALID'
  );
});

test('unindexed edition is refused (BOOK_NOT_INDEXED)', async () => {
  const runQuery = async (sql) =>
    sql.includes('FROM book_editions')
      ? { rows: [{ source_id: null, ingestion_status: 'NOT_INGESTED' }] }
      : { rows: [] };
  await assert.rejects(
    () =>
      researchQuery(
        { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'Q?' },
        { runQuery }
      ),
    (err) => err.code === 'BOOK_NOT_INDEXED'
  );
});

// ============================================================================
// Conversation ownership (14) + scope match
// ============================================================================

test('conversation owned by another user is FORBIDDEN', async () => {
  const runQuery = async (sql) => {
    if (sql.includes('FROM book_editions')) {
      return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED', book_title: 'B', edition_label: 'E' }] };
    }
    if (sql.includes('FROM conversations WHERE id')) {
      return { rows: [{ id: 'c', user_id: 'someone-else', book_id: 'b', edition_id: 'e' }] };
    }
    return { rows: [] };
  };
  await assert.rejects(
    () =>
      researchQuery(
        { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'Q?' },
        { runQuery }
      ),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('conversation pointing to a different book is a scope mismatch', async () => {
  const runQuery = async (sql) => {
    if (sql.includes('FROM book_editions')) {
      return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED' }] };
    }
    if (sql.includes('FROM conversations WHERE id')) {
      return { rows: [{ id: 'c', user_id: 'u', book_id: 'OTHER', edition_id: 'e' }] };
    }
    return { rows: [] };
  };
  await assert.rejects(
    () =>
      researchQuery(
        { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'Q?' },
        { runQuery }
      ),
    (err) => err.code === 'CONVERSATION_SCOPE_MISMATCH'
  );
});

// ============================================================================
// 3. vector retrieval filtering (scoped + parameterized)
// ============================================================================

test('vector retrieval scopes by book/edition/source and binds the vector as a parameter', async () => {
  let captured = null;
  const runQuery = async (sql, params) => {
    captured = { sql, params };
    return { rows: [makeRow({ id: 'a', distance: 0.1 }), makeRow({ id: 'b', distance: 0.4 })] };
  };
  const out = await vectorRetrieval({
    vector: [0.1, 0.2, 0.3],
    bookId: 'book-9',
    editionId: 'ed-9',
    sourceId: 'src-9',
    runQuery,
  });
  assert.match(captured.sql, /c\.book_id = \$2/);
  assert.match(captured.sql, /c\.edition_id = \$3/);
  assert.match(captured.sql, /c\.book_source_id = \$4/);
  assert.equal(captured.params[1], 'book-9');
  assert.equal(captured.params[2], 'ed-9');
  assert.equal(captured.params[3], 'src-9');
  // vector is passed as a bound literal, never string-interpolated into SQL text
  assert.ok(!captured.sql.includes('0.1,0.2,0.3'));
  assert.equal(out[0].chunkId, 'a');
  assert.equal(out[0].retrieval.vectorRank, 1);
  assert.ok(Math.abs(out[0].retrieval.vectorScore - 0.9) < 1e-9);
});

// ============================================================================
// 4. lexical retrieval
// ============================================================================

test('lexical retrieval uses FTS and returns normalized candidates', async () => {
  let captured = null;
  const runQuery = async (sql, params) => {
    captured = { sql, params };
    return { rows: [makeRow({ id: 'a', rank: 0.5 })] };
  };
  const out = await lexicalRetrieval({ text: 'Ivan God', bookId: 'b', editionId: 'e', runQuery });
  assert.match(captured.sql, /search_tsv @@ websearch_to_tsquery/);
  assert.equal(captured.params[0], 'Ivan God');
  assert.equal(out[0].retrieval.lexicalRank, 1);
  assert.equal(out[0].retrieval.lexicalScore, 0.5);
});

test('empty lexical term short-circuits to [] without a query', async () => {
  let called = false;
  const out = await lexicalRetrieval({ text: '  ', bookId: 'b', editionId: 'e', runQuery: async () => { called = true; return { rows: [] }; } });
  assert.equal(out.length, 0);
  assert.equal(called, false);
});

// ============================================================================
// 5. hybrid fusion + 6. dedup + 7. deterministic ranking
// ============================================================================

test('RRF dedups a chunk present in both lists and boosts it', () => {
  const v = [candidate('a', { vectorRank: 1, vectorScore: 0.9 }), candidate('b', { vectorRank: 2, vectorScore: 0.7 })];
  const l = [candidate('b', { lexicalRank: 1, lexicalScore: 0.5 })]; // b overlaps
  const fused = rrfFusion(v, l, { k: 60, vectorWeight: 1, lexicalWeight: 1 });
  const ids = fused.map((c) => c.chunkId);
  assert.equal(ids.length, 2, 'deduped to 2 unique chunks');
  assert.equal(ids[0], 'b', 'b surfaces in both lists so it ranks first');
  const b = fused.find((c) => c.chunkId === 'b');
  assert.equal(b.retrieval.vectorRank, 2);
  assert.equal(b.retrieval.lexicalRank, 1);
  const expectedB = 1 / 62 + 1 / 61;
  assert.ok(Math.abs(b.hybridScore - expectedB) < 1e-9);
});

test('fusion ordering is deterministic for identical inputs', () => {
  const build = () => [candidate('x', { vectorRank: 1 }), candidate('y', { vectorRank: 2 })];
  const a = rrfFusion(build(), [], { k: 60 });
  const b = rrfFusion(build(), [], { k: 60 });
  assert.deepEqual(a.map((c) => c.chunkId), b.map((c) => c.chunkId));
});

// ============================================================================
// 8. reranker fallback honesty
// ============================================================================

test('rerank with no provider preserves hybrid order and invents no new score', async () => {
  const cands = [
    { ...candidate('a', {}), hybridScore: 0.032 },
    { ...candidate('b', {}), hybridScore: 0.016 },
  ];
  const { provider, ranked } = await rerank({ query: 'Q', candidates: cands, reranker: null, topN: 8 });
  assert.equal(provider, 'NOT_CONFIGURED');
  assert.deepEqual(ranked.map((c) => c.chunkId), ['a', 'b']);
  assert.equal(ranked[0].rerank.provider, 'NOT_CONFIGURED');
  assert.equal(ranked[0].rerank.score, 0.032, 'score mirrors real hybrid score');
});

test('configured reranker reorders by provided relevance', async () => {
  const fake = { name: 'test', model: 'm', rank: async (_q, texts) => texts.map((t) => (t === 'second' ? 1 : 0)) };
  const cands = [
    { ...candidate('a', {}), text: 'first', hybridScore: 0.9 },
    { ...candidate('b', {}), text: 'second', hybridScore: 0.1 },
  ];
  const { provider, ranked } = await rerank({ query: 'Q', candidates: cands, reranker: fake, topN: 8 });
  assert.equal(provider, 'test');
  assert.equal(ranked[0].chunkId, 'b', 'reranker moved the relevant one to the top');
  assert.equal(ranked[0].rerank.score, 1);
});

test('reranker that throws degrades honestly, not by fabricating', async () => {
  const boom = { name: 'test', model: 'm', rank: async () => { throw new Error('RERANK_ERROR_503'); } };
  const cands = [{ ...candidate('a', {}), hybridScore: 0.5 }, { ...candidate('b', {}), hybridScore: 0.2 }];
  const { provider, ranked } = await rerank({ query: 'Q', candidates: cands, reranker: boom, topN: 8 });
  assert.equal(provider, 'HYBRID_FALLBACK_AFTER_ERROR');
  assert.deepEqual(ranked.map((c) => c.chunkId), ['a', 'b']);
});

// ============================================================================
// 9. evidence object + 10. evidence id resolution + 13. model page rejection
// ============================================================================

test('toCitation sources every field from the DB row, never from generated text', () => {
  const ev = toEvidence({ ...candidate('a', {}, { page_start: 427, page_end: 428, chapter: 'Book XI' }), retrieval: { vectorRank: 1 } }, 'e1');
  const cit = toCitation(ev);
  assert.equal(cit.evidenceId, 'e1');
  assert.equal(cit.page, 427);
  assert.equal(cit.chapter, 'Book XI');
  assert.equal(cit.chunkId, 'a');
});

// ============================================================================
// 11. insufficient evidence
// ============================================================================

test('decideSufficiency flags an empty candidate set', () => {
  const d = decideSufficiency([], { minCount: 1, minScore: 0 });
  assert.equal(d.sufficient, false);
});

test('researchQuery (no evidence) asks the model for a note, never a book claim', async () => {
  const runQuery = pipelineRunQuery({ vectorRows: [], lexicalRows: [] });
  let groqMessages = null;
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What does Ivan say about God?' },
    {
      runQuery,
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      // The note call is the ONLY model call allowed on an empty evidence set.
      groq: async (messages) => {
        groqMessages = messages;
        return 'Nothing in that book matched Ivan and God under that wording — try a broader theme.';
      },
    }
  );
  assert.equal(res.status, 'insufficient');
  assert.equal(res.confidence, 'insufficient');
  assert.deepEqual(res.citations, [], 'no citations may be attached to a no-evidence reply');
  assert.deepEqual(res.evidenceIds, [], 'no evidence ids may be claimed without evidence');
  assert.notEqual(res.answer, INSUFFICIENT_MESSAGE, 'must not be the old fixed string');
  assert.ok(groqMessages, 'the miss is phrased naturally instead of canned');
  // The note prompt forbids inventing book content and carries no evidence block.
  assert.match(groqMessages[0].content, /no matching passage/i);
  assert.match(groqMessages[0].content, /Do not state, hint at, or guess any fact/i);
  assert.ok(!groqMessages[1].content.includes('EVIDENCE:'), 'no evidence is handed to the model');
});

test('no-evidence note degrades to a question-specific fallback, never a guess', async () => {
  const text = noEvidenceFallback({ question: 'what is drmiti', bookContext: { title: 'Zero to One' }, searchedTerms: ['drmiti'] });
  assert.match(text, /Zero to One/);
  assert.match(text, /drmiti/);
  assert.notEqual(text, INSUFFICIENT_MESSAGE);
  // A model that returns junk is rejected in favour of the honest fallback.
  const note = await generateNoEvidenceNote({
    question: 'what is drmiti',
    bookContext: { title: 'Zero to One' },
    searchedTerms: ['drmiti'],
    groq: async () => '',
  });
  assert.equal(note, noEvidenceFallback({ question: 'what is drmiti', bookContext: { title: 'Zero to One' }, searchedTerms: ['drmiti'] }));
  const thrown = await generateNoEvidenceNote({
    question: 'q',
    groq: async () => { throw new Error('GROQ_DOWN'); },
  });
  assert.match(thrown, /searched this book/i);
});

// ============================================================================
// 12. model evidence-id validation (reject hallucinated ids)
// ============================================================================

test('validateEvidenceIds keeps only supplied ids', () => {
  const { accepted, rejected } = validateEvidenceIds(['e1', 'e99', 'e1', 'made-up'], new Set(['e1', 'e2']));
  assert.deepEqual(accepted, ['e1']);
  assert.deepEqual(rejected, ['e99', 'made-up']);
});

// ============================================================================
// 15. Groq prompt construction
// ============================================================================

test('system prompt enforces grounding without a fixed stock sentence', () => {
  const p = buildSystemPrompt();
  assert.match(p, /ONLY the supplied evidence/);
  assert.match(p, /Do not invent/i);
  // The old behaviour forced one identical canned line for every miss; the
  // prompt must now explicitly forbid that and demand question-specific wording.
  assert.ok(!p.includes(INSUFFICIENT_MESSAGE), 'no hardcoded sentence handed to the model');
  assert.match(p, /Do not repeat a fixed stock sentence/i);
  assert.match(p, /never as a claim that the book "never mentions"/);
  assert.match(p, /set confidence to "insufficient"/);

  const s = buildStreamingMessages({ question: 'q', evidence: [] })[0].content;
  assert.match(s, /Do not repeat a fixed stock sentence/i);
  assert.ok(!s.includes(INSUFFICIENT_MESSAGE));
});

test('evidence block and messages carry DB ids/pages and the question, never coordinates', () => {
  const ev = [toEvidence({ ...candidate('a', {}, { page_start: 427, page_end: 427, chapter: 'XI' }) }, 'e1')];
  const block = buildEvidenceBlock(ev);
  assert.match(block, /\[e1\]/);
  assert.match(block, /page 427/);
  assert.match(block, /Book|XI/);
  const msgs = buildMessages({ question: 'Why does Ivan believe that?', evidence: ev, contextMessages: [{ role: 'user', content: 'prior' }], bookContext: { title: 'The Brothers Karamazov', editionLabel: 'Garnett' } });
  assert.equal(msgs[0].role, 'system');
  assert.match(msgs[1].content, /QUESTION: Why does Ivan believe that\?/);
  assert.match(msgs[1].content, /The Brothers Karamazov/);
  assert.ok(!JSON.stringify(msgs).includes('"spans"'), 'no raw provenance handed to the model');
});

// ============================================================================
// 16. structured answer parsing
// ============================================================================

test('parseStructuredAnswer handles fenced and loose JSON', () => {
  const obj = { answer: 'x', evidenceIds: ['e1'], confidence: 'supported' };
  assert.deepEqual(parseStructuredAnswer('```json\n' + JSON.stringify(obj) + '\n```'), obj);
  assert.deepEqual(parseStructuredAnswer('noise ' + JSON.stringify(obj) + ' trailing'), obj);
  assert.equal(parseStructuredAnswer('not json'), null);
});

test('generateAnswer clamps contradictory confidence and drops hallucinated ids', async () => {
  const ev = [toEvidence(candidate('a', {}), 'e1'), toEvidence(candidate('b', {}), 'e2')];
  const groq = async () => JSON.stringify({ answer: 'A.', evidenceIds: ['e1', 'eZZ'], confidence: 'garbage' });
  const out = await generateAnswer({ question: 'Q', evidence: ev, groq });
  assert.deepEqual(out.evidenceIds, ['e1']);
  assert.deepEqual(out.rejectedEvidenceIds, ['eZZ']);
  assert.equal(out.confidence, 'partially_supported');
});

// ============================================================================
// End-to-end happy path with the whole pipeline mocked
// ============================================================================

function pipelineRunQuery({ vectorRows, lexicalRows, messages = [] }) {
  return async (sql) => {
    if (sql.includes('FROM book_editions')) {
      return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED', book_title: 'B', edition_label: 'E' }] };
    }
    if (sql.includes('FROM conversations WHERE id')) {
      return { rows: [{ id: 'c', user_id: 'u', book_id: 'b', edition_id: 'e' }] };
    }
    if (sql.includes('FROM conversation_messages') && sql.includes('ORDER BY created_at')) {
      return { rows: messages };
    }
    if (sql.includes('embedding <=>')) return { rows: vectorRows };
    if (sql.includes('search_tsv')) return { rows: lexicalRows };
    return { rows: [] }; // inserts / updates
  };
}

test('researchQuery runs validate -> retrieve -> fuse -> rerank -> generate -> resolve -> persist', async () => {
  const inserts = [];
  const base = pipelineRunQuery({
    vectorRows: [makeRow({ id: 'a', distance: 0.2, page_start: 10, source_text: 'Ivan on God.' }),
      makeRow({ id: 'b', distance: 0.5, page_start: 427, source_text: 'Alyosha believes.' })],
    lexicalRows: [makeRow({ id: 'b', rank: 0.5, page_start: 427, source_text: 'Alyosha believes.' })],
  });
  const runQuery = async (sql, params) => {
    if (/INSERT INTO conversation_messages/.test(sql)) inserts.push({ sql, params });
    return base(sql, params);
  };
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What does Ivan say about God?' },
    {
      runQuery,
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      groq: async () => JSON.stringify({ answer: 'Ivan denies God.', evidenceIds: ['e1'], confidence: 'supported' }),
    }
  );
  assert.equal(res.status, 'ok');
  assert.equal(res.confidence, 'supported');
  assert.equal(res.citations.length, 1);
  assert.equal(res.citations[0].text, 'Alyosha believes.', 'citation text is the DB row, not model prose');
  // e1 is the strongest fused candidate (b appears in both lists) -> page 427
  assert.equal(res.citations[0].page, 427);
  assert.equal(inserts.length, 2, 'user + assistant messages persisted');
  const meta = JSON.parse(inserts[1].params[2]);
  assert.deepEqual(meta.evidenceIds, ['e1']);
  assert.ok(!meta.evidenceIds.includes('e99'));
});

// ============================================================================
// Query understanding (follow-up resolution) — §6/§7/§8
// ============================================================================

test('follow-up resolves an anaphoric subject from the prior turn verbatim', () => {
  const recent = [{ role: 'user', content: 'What does Ivan believe about God?' }];
  const u = understandQuery({ message: 'Why does he believe that?', recentMessages: recent });
  assert.equal(u.isFollowUp, true);
  assert.match(u.resolvedSubject, /Ivan/);
  assert.match(u.searchQuery, /Ivan/);
});

test('non-follow-up keeps the original query untouched', () => {
  const u = understandQuery({ message: 'Explain the Grand Inquisitor chapter.', recentMessages: [] });
  assert.equal(u.isFollowUp, false);
  assert.equal(u.searchQuery, 'Explain the Grand Inquisitor chapter.');
});

test('ambiguous follow-up with no recoverable subject does not guess', () => {
  const u = understandQuery({ message: 'why does he think so?', recentMessages: [{ role: 'user', content: 'tell me more' }] });
  assert.equal(u.resolvedSubject, null);
  assert.equal(u.searchQuery, 'why does he think so?');
});
