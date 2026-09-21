import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spansToRects, attachRectsToEvidence } from '../src/retrieval/geometry.js';
import {
  createAnswerSplitter,
  CITATION_DELIM,
  generateAnswerStreaming,
  buildStreamingMessages,
} from '../src/rag/generation.js';
import { toEvidence, rowToCandidate } from '../src/retrieval/evidence.js';
import { researchQuery } from '../src/services/researchService.js';
import { ragConfig } from '../src/config/rag.js';

// ============================================================================
// Geometry: chunk spans -> REAL text-item rectangles (Phase 4 §20/§21).
// ============================================================================

const item = (charStart, charEnd, x, y = 700, w = 40, h = 12) => ({
  str: 'x', charStart, charEnd, x, y, width: w, height: h,
});

test('spansToRects maps a span to exactly the items it overlaps', () => {
  const items = [item(0, 10, 72, 754), item(10, 20, 112, 754), item(20, 30, 72, 740)];
  const spans = [{ pageNumber: 1, charStart: 10, charEnd: 20 }];
  const rects = spansToRects(spans, items);
  assert.equal(rects.length, 1, 'only the middle item is inside the span');
  assert.equal(rects[0].x, 112);
});

test('spansToRects merges multiple spans into multiple real rects', () => {
  const items = [item(0, 10, 1), item(10, 20, 2), item(30, 40, 3), item(40, 50, 4)];
  const spans = [{ charStart: 0, charEnd: 10 }, { charStart: 30, charEnd: 40 }];
  const rects = spansToRects(spans, items);
  assert.deepEqual(rects.map((r) => r.x), [1, 3]);
});

test('spansToRects returns nothing when items lack real coordinates', () => {
  const items = [{ str: 'x', charStart: 0, charEnd: 5, x: null, y: null, width: null, height: null }];
  assert.deepEqual(spansToRects([{ charStart: 0, charEnd: 5 }], items), []);
});

test('spansToRects returns nothing when the source has no spans or items', () => {
  assert.deepEqual(spansToRects([], [item(0, 5, 1, 1)]), []);
  assert.deepEqual(spansToRects([{ charStart: 0, charEnd: 5 }], []), []);
  assert.deepEqual(spansToRects([{ charStart: 0, charEnd: 5 }], null), []);
});

test('spansToRects skips items with no usable area (zero width/height)', () => {
  const items = [{ str: 'x', charStart: 0, charEnd: 5, x: 1, y: 1, width: 0, height: 12 }];
  assert.deepEqual(spansToRects([{ charStart: 0, charEnd: 5 }], items), []);
});

test('attachRectsToEvidence leaves a no-coordinate citation with empty rects', async () => {
  const ev = toEvidence(rowToCandidate({ id: 'c1', page_id: 'p1', book_source_id: 's1', coordinates_available: false, spans: [] }), 'e1');
  await attachRectsToEvidence({ runQuery: async () => ({ rows: [] }), evidence: [ev] });
  assert.deepEqual(ev.rects, []);
});

test('attachRectsToEvidence loads a page once and maps its spans to rects', async () => {
  let queries = 0;
  const runQuery = async () => {
    queries++;
    return { rows: [{ coordinates_available: true, text_items: [item(0, 10, 72, 754), item(10, 20, 112, 754)] }] };
  };
  const mk = () => toEvidence(
    rowToCandidate({ id: 'c1', page_id: 'p1', book_source_id: 's1', coordinates_available: true, spans: [{ pageNumber: 1, charStart: 10, charEnd: 20 }] }),
    'e1'
  );
  const ev = mk();
  await attachRectsToEvidence({ runQuery, evidence: [ev] });
  assert.equal(ev.rects.length, 1);
  assert.equal(ev.rects[0].x, 112);
  assert.equal(queries, 1);
});

// ============================================================================
// Streaming answer/trailer splitter (Phase 4 §14).
// ============================================================================

test('splitter streams answer text and never leaks the delimiter', () => {
  const s = createAnswerSplitter();
  let out = '';
  out += s.push('Ivan argues that ') ?? '';
  out += s.push('faith needs ') ?? '';
  out += s.push(`free will.\n${CITATION_DELIM}\n{"evidenceIds":["e1"],"confidence":"supported"}`) ?? '';
  assert.equal(out, 'Ivan argues that faith needs free will.');
  assert.ok(!out.includes(CITATION_DELIM));
  assert.equal(s.isDone(), true);
  assert.match(s.trailer(), /evidenceIds/);
});

test('splitter flushes held-back tail when the stream ends without a delimiter', () => {
  const s = createAnswerSplitter();
  let out = s.push('A plain answer.') ?? '';
  // nothing withheld yet because 'A plain answer.' is shorter than delim? push emits all but tail.
  out += s.flushTail();
  assert.equal(out, 'A plain answer.');
  assert.equal(s.isDone(), false);
});

test('splitter handles a delimiter split across two chunks', () => {
  const s = createAnswerSplitter();
  const half = CITATION_DELIM.slice(0, 6);
  let answer = s.push(`Answer body ${half}`) ?? '';
  answer += s.push(`${CITATION_DELIM.slice(6)}{"evidenceIds":[]}`) ?? '';
  assert.equal(answer, 'Answer body');
  assert.equal(s.isDone(), true);
});

// ============================================================================
// generateAnswerStreaming — real deltas, validated ids, no fabricated citation.
// ============================================================================

const ev1 = toEvidence(rowToCandidate({ id: 'a' }), 'e1');
const ev2 = toEvidence(rowToCandidate({ id: 'b' }), 'e2');

function fakeStream(parts) {
  return async function* () {
    for (const p of parts) yield p;
  };
}

test('generateAnswerStreaming forwards only answer deltas and validates ids', async () => {
  const deltas = [];
  const stream = fakeStream([
    'Ivan ', 'denies ', 'God. ',
    `\n${CITATION_DELIM}\n{"evidenceIds":["e1","eZZ"],"confidence":"supported"}`,
  ]);
  const res = await generateAnswerStreaming({
    question: 'Q', evidence: [ev1, ev2], stream, onDelta: (d) => deltas.push(d),
  });
  assert.equal(res.answer, 'Ivan denies God.');
  assert.equal(deltas.join(''), 'Ivan denies God.');
  assert.ok(!deltas.join('').includes(CITATION_DELIM));
  assert.deepEqual(res.evidenceIds, ['e1']);
  assert.deepEqual(res.rejectedEvidenceIds, ['eZZ']);
  assert.equal(res.confidence, 'supported');
});

test('generateAnswerStreaming with no trailer cites nothing (never fabricates)', async () => {
  const stream = fakeStream(['Just an answer with no structured citations.']);
  const res = await generateAnswerStreaming({ question: 'Q', evidence: [ev1], stream });
  assert.deepEqual(res.evidenceIds, []);
  assert.equal(res.confidence, 'insufficient', 'cannot claim support without cited ids');
});

test('streaming system prompt keeps grounding and the delimiter protocol', () => {
  const msgs = buildStreamingMessages({ question: 'Why?', evidence: [ev1] });
  assert.match(msgs[0].content, /ONLY the supplied evidence/);
  assert.ok(msgs[0].content.includes(CITATION_DELIM));
  assert.match(msgs[1].content, /QUESTION: Why\?/);
});

// ============================================================================
// researchQuery emits the canonical event stream with real token deltas.
// ============================================================================

function streamRunQuery({ vectorRows, lexicalRows }) {
  return async (sql) => {
    if (sql.includes('FROM book_editions')) {
      return { rows: [{ source_id: 'src-1', ingestion_status: 'COMPLETED', book_title: 'B', edition_label: 'E' }] };
    }
    if (sql.includes('FROM conversations WHERE id')) {
      return { rows: [{ id: 'c', user_id: 'u', book_id: 'b', edition_id: 'e' }] };
    }
    if (sql.includes('FROM conversation_messages') && sql.includes('ORDER BY created_at')) return { rows: [] };
    if (sql.includes('embedding <=>')) return { rows: vectorRows };
    if (sql.includes('search_tsv')) return { rows: lexicalRows };
    if (sql.includes('FROM book_pages')) return { rows: [] };
    return { rows: [] };
  };
}

test('researchQuery (streaming) emits ordered events and forwards real answer deltas', async () => {
  const events = [];
  const emit = (type, data) => events.push({ type, data });
  const makeRow2 = (over) => ({
    id: 'x', book_id: 'b', edition_id: 'e', book_source_id: 'src-1', page_id: 'p',
    chunk_uid: 'u', page_start: 1, page_end: 1, chapter: null, source_text: 'text',
    search_text: 'text', spans: [], coordinates_available: false, ...over,
  });
  const runQuery = streamRunQuery({
    vectorRows: [makeRow2({ id: 'a', distance: 0.2, page_start: 10, source_text: 'Ivan on God.' }),
      makeRow2({ id: 'b', distance: 0.5, page_start: 427, source_text: 'Alyosha believes.' })],
    lexicalRows: [makeRow2({ id: 'b', rank: 0.5, page_start: 427, source_text: 'Alyosha believes.' })],
  });
  const stream = fakeStream([
    'Ivan denies ', 'God in the chapter. ',
    `\n${CITATION_DELIM}\n{"evidenceIds":["e1"],"confidence":"supported"}`,
  ]);
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What does Ivan say about God?' },
    {
      runQuery,
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      stream,
      emit,
    }
  );

  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    'context_resolved', 'searching', 'searching', 'retrieval_complete',
    'reranking', 'evidence_selected', 'generating', 'answer_chunk', 'answer_chunk',
    'validation_complete', 'sources_ready',
  ]);
  // retrieval_complete carries the real candidate counts, not fabricated numbers.
  const rc = events.find((e) => e.type === 'retrieval_complete');
  assert.equal(rc.data.hybridCandidates, 2);
  assert.equal(rc.data.vectorCandidates, 2);
  // the fallback reranker is labelled honestly, never as a configured reranker.
  assert.equal(events.find((e) => e.type === 'reranking').data.provider, 'hybrid_fallback');
  // two answer deltas = the model's actual chunks, not one synthesized blob.
  const chunks = events.filter((e) => e.type === 'answer_chunk').map((e) => e.data.delta);
  assert.equal(chunks.join(''), 'Ivan denies God in the chapter.');
  // citations resolve to the DB row, and evidence_selected reports the real count.
  assert.equal(res.citations.length, 1);
  assert.equal(res.citations[0].page, 427);
  assert.equal(res.citations[0].text, 'Alyosha believes.');
  assert.equal(events.find((e) => e.type === 'evidence_selected').data.evidenceCount, 2);
});

test('researchQuery (insufficient) preserves Phase 3 and still closes the stream', async () => {
  const events = [];
  const runQuery = streamRunQuery({ vectorRows: [], lexicalRows: [] });
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What is the weather on Mars?' },
    {
      runQuery,
      makeProvider: () => ({ embedBatch: async (t) => t.map(() => new Array(ragConfig.embeddingDim).fill(0.1)) }),
      reranker: null,
      stream: async function* () { throw new Error('must-not-be-called'); },
      // Hermetic: the no-evidence note must use this mock, never the live API.
      groq: async () => 'Nothing in this book matched the weather on Mars — try a question about the book itself.',
      emit: (type, data) => events.push({ type, data }),
    }
  );
  assert.equal(res.status, 'insufficient');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('retrieval_complete'));
  assert.ok(types.includes('sources_ready'));
  assert.equal(events.find((e) => e.type === 'sources_ready').data.sources.length, 0);
});
