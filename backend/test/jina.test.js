import { test } from 'node:test';
import assert from 'node:assert/strict';

import { env } from '../src/config/env.js';
import {
  JinaEmbeddingProvider,
  HuggingFaceEmbeddingProvider,
  EmbeddingError,
  embedQuery,
  embeddingConfigured,
  embeddingProviderInfo,
  makeEmbeddingProvider,
  normalizeJinaResponse,
  probeDimension,
  validateVectors,
} from '../src/ingest/embeddingProvider.js';
import { embedSource } from '../src/ingest/embedSource.js';
import { vectorRetrieval } from '../src/retrieval/vectorRetrieval.js';
import { rrfFusion } from '../src/retrieval/hybridFusion.js';
import { rowToCandidate } from '../src/retrieval/evidence.js';
import { researchQuery } from '../src/services/researchService.js';
import { makeClient, nChunks, makeProvider, cfg, connectTo, jinaPayload, jsonResponse } from './helpers/embeddingFixtures.js';

// Proves the Jina vendor is a drop-in behind the SAME abstraction: identical job
// semantics (probe -> dimension guard -> only-NULL -> batched txn -> resume) and
// identical query-path honesty (any failure degrades to real FTS, never a fake
// vector). Nothing here touches the network or a database.

const KEY = 'jina_KEY_DO_NOT_LOG_abcdef1234567890';

function jinaProvider({ fetchImpl, dim = 4, model = 'jina-embeddings-v3' } = {}) {
  return new JinaEmbeddingProvider({
    apiKey: KEY,
    model,
    retryBaseMs: 1,
    timeoutMs: 50,
    fetchImpl: fetchImpl ?? (async (url, init) => jsonResponse(jinaPayload(JSON.parse(init.body).input, { dim }))),
  });
}

// ============================================================================
// A. transport success: real Jina envelope -> one vector per input, in order
// ============================================================================

test('A: jina batch succeeds and normalizes {data:[{index,embedding}]}', async () => {
  const seen = [];
  const provider = new JinaEmbeddingProvider({
    apiKey: KEY,
    model: 'jina-embeddings-v3',
    retryBaseMs: 1,
    timeoutMs: 50,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(jinaPayload(JSON.parse(init.body).input, { dim: 4 }));
    },
  });
  const vectors = await provider.embedBatch(['alpha', 'beta longer']);
  assert.equal(seen[0].url, 'https://api.jina.ai/v1/embeddings');
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body.input, ['alpha', 'beta longer'], 'the batch really carries every chunk');
  assert.equal(body.model, 'jina-embeddings-v3');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(seen[0].init.signal, 'every request carries a bounded timeout signal');
  assert.equal(vectors.length, 2);
  assert.equal(vectors[0].length, 4);
  assert.equal(provider.modelId(), 'jina-embeddings-v3');
});

test('A2: out-of-order response items are restored to input order', async () => {
  const out = normalizeJinaResponse(
    { data: [{ index: 1, embedding: [1, 1] }, { index: 0, embedding: [0, 0] }] },
    2
  );
  assert.deepEqual(out, [[0, 0], [1, 1]], 'a vector can never land on the wrong chunk');
});

test('A3: probeDimension reports the dimension measured from the live response', async () => {
  assert.equal(await probeDimension(jinaProvider({ dim: 7 })), 7);
});

test('A4: the requested dimension is the configured column width, and only that', async () => {
  const bodies = [];
  const spy = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse(jinaPayload(JSON.parse(init.body).input, { dim: 384 }));
  };
  await new JinaEmbeddingProvider({ apiKey: KEY, model: 'jina-embeddings-v3', dimensions: 384, retryBaseMs: 1, timeoutMs: 50, fetchImpl: spy })
    .embedBatch(['a']);
  assert.equal(bodies[0].dimensions, 384, 'asks the model for the width the column already has');
  await new JinaEmbeddingProvider({ apiKey: KEY, model: 'jina-embeddings-v3', retryBaseMs: 1, timeoutMs: 50, fetchImpl: spy })
    .embedBatch(['a']);
  assert.equal('dimensions' in bodies[1], false, 'no dimension is invented when none is configured');
});

test('A5: the selected vendor gets its dimension from EMBEDDING_DIM, never a literal', () => {
  const saved = {
    embeddingProvider: env.embeddingProvider,
    jinaApiKey: env.jinaApiKey,
    jinaEmbeddingModel: env.jinaEmbeddingModel,
    embeddingDim: env.embeddingDim,
  };
  try {
    Object.assign(env, { embeddingProvider: 'jina', jinaApiKey: KEY, jinaEmbeddingModel: 'jina-embeddings-v3', embeddingDim: 384 });
    assert.equal(makeEmbeddingProvider().dimensions, 384);
    Object.assign(env, { embeddingDim: 512 });
    assert.equal(makeEmbeddingProvider().dimensions, 512);
  } finally {
    Object.assign(env, saved);
  }
});

// ============================================================================
// B/C/D/E/F. transport failures: finite timeout, bounded retries, no hangs
// ============================================================================

test('B: socket timeout -> EMBEDDING_TIMEOUT, retried a bounded number of times', async () => {
  let n = 0;
  const provider = jinaProvider({
    fetchImpl: async () => { n++; throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
  });
  await assert.rejects(
    () => provider.embedBatch(['x']),
    (e) => e.code === 'EMBEDDING_TIMEOUT' && e.retryable
  );
  assert.ok(n > 1 && n <= 6, `retries bounded (saw ${n})`);
});

test('C: DNS failure -> EMBEDDING_NETWORK, no unhandled rejection', async () => {
  const provider = jinaProvider({ fetchImpl: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  await assert.rejects(() => provider.embedBatch(['x']), (e) => e.code === 'EMBEDDING_NETWORK' && e.retryable);
});

test('D: 401/403 are reported honestly and never retried', async () => {
  for (const status of [401, 403]) {
    let n = 0;
    const provider = jinaProvider({ fetchImpl: async () => { n++; return jsonResponse({ error: 'Authentication failed.' }, status); } });
    await assert.rejects(() => provider.embedBatch(['x']), (e) => e.code === `EMBEDDING_HTTP_${status}` && !e.retryable);
    assert.equal(n, 1, `${status} must not be retried`);
  }
});

test('E: 429 is retried with backoff and stays bounded', async () => {
  let n = 0;
  const provider = jinaProvider({ fetchImpl: async () => { n++; return jsonResponse({ error: 'Too Many Requests' }, 429); } });
  await assert.rejects(() => provider.embedBatch(['x']), (e) => e.code === 'EMBEDDING_HTTP_429' && e.retryable);
  assert.ok(n > 1 && n <= 6, `429 retries bounded (saw ${n})`);
});

test('F: 5xx is retried and stays bounded', async () => {
  for (const status of [500, 503]) {
    let n = 0;
    const provider = jinaProvider({ fetchImpl: async () => { n++; return jsonResponse({ error: 'upstream boom' }, status); } });
    await assert.rejects(() => provider.embedBatch(['x']), (e) => e.code === `EMBEDDING_HTTP_${status}` && e.retryable);
    assert.ok(n > 1 && n <= 6, `${status} retries bounded (saw ${n})`);
  }
});

// ============================================================================
// G/H/I. malformed payloads and bad vectors never reach the database
// ============================================================================

test('G: malformed responses fail with explicit codes', async () => {
  assert.throws(() => normalizeJinaResponse({}, 1), (e) => e.code === 'EMBEDDING_MALFORMED_RESPONSE');
  assert.throws(() => normalizeJinaResponse({ data: 'nope' }, 1), (e) => e.code === 'EMBEDDING_MALFORMED_RESPONSE');
  assert.throws(() => normalizeJinaResponse({ data: [{ index: 0, embedding: [1, 2] }] }, 2), (e) => e.code === 'EMBEDDING_COUNT_MISMATCH');
  const provider = jinaProvider({ fetchImpl: async () => jsonResponse({ error: 'model not found' }) });
  await assert.rejects(() => provider.embedBatch(['x']), (e) => e.code === 'EMBEDDING_MODEL_ERROR');
});

test('H: NaN/Infinity inside a real Jina payload is rejected', () => {
  assert.throws(() => validateVectors([[1, NaN, 3]], 3), (e) => e.code === 'EMBEDDING_NAN');
  assert.throws(() => validateVectors([[1, Infinity, 3]], 3), (e) => e.code === 'EMBEDDING_INFINITY');
});

test('I: Jina 1024-dim against a 384 column stops with the exact report and zero writes', async () => {
  const client = makeClient(nChunks(4));
  const provider = jinaProvider({ dim: 1024 });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 384 }),
    (e) => {
      assert.equal(e.code, 'EMBEDDING_DIMENSION_MISMATCH');
      assert.equal(e.detail.report, 'JINA_EMBEDDING_DIMENSION_MISMATCH expected=384 actual=1024');
      return true;
    }
  );
  assert.equal(client.state.updatesApplied, 0, 'no incompatible vector is ever written');
  assert.equal(client.state.committedBatches, 0);
  assert.equal(client.state.chunks.every((c) => c.embedding === null), true);
});

// ============================================================================
// J/K/L/M/N. job semantics under Jina: only-NULL, scoping, lock, rollback, resume
// ============================================================================

test('J+K: embeds only NULL chunks, pre-embedded rows untouched, one probe + batches', async () => {
  const client = makeClient(nChunks(5, 2)); // 2 rows already carry a sentinel vector
  const provider = jinaProvider({ dim: 3 });
  const r = await embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 });
  assert.equal(r.total, 5);
  assert.equal(r.embedded, 5);
  assert.equal(r.nullEmbeddings, 0);
  assert.equal(r.dim, 3, 'dimension reported back is the measured one');
  assert.equal(r.ok, true);
  assert.equal(client.state.chunks[0].embedding, '[9]');
  assert.equal(client.state.chunks[1].embedding, '[9]');
});

test('L: an unknown or un-ingested source is never embedded', async () => {
  const missing = makeClient(nChunks(3), { sourceMissing: true });
  await assert.rejects(
    () => embedSource({ slug: 'nope', edition: 'e', provider: jinaProvider({ dim: 3 }), connect: connectTo(missing), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'SOURCE_NOT_FOUND'
  );
  const notReady = makeClient(nChunks(3), { status: 'FAILED' });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: jinaProvider({ dim: 3 }), connect: connectTo(notReady), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'SOURCE_NOT_READY'
  );
});

test('M: a duplicate job fails fast on the advisory lock', async () => {
  const client = makeClient(nChunks(3), { lockAcquired: false });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: jinaProvider({ dim: 3 }), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'EMBEDDING_JOB_ALREADY_RUNNING'
  );
  assert.equal(client.state.updatesApplied, 0);
});

test('N: a failing batch rolls back alone, committed batches persist', async () => {
  const client = makeClient(nChunks(4), { failUpdateIds: ['c3'] });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: jinaProvider({ dim: 3 }), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /WRITE_FAILED/
  );
  assert.equal(client.state.committedBatches, 1);
  assert.equal(client.state.rolledBack, 1);
  assert.equal(client.state.updatesApplied, 2);
  assert.deepEqual(client.state.chunks.map((c) => c.embedding === null), [false, false, true, true]);
});

test('N2: a provider outage mid-job leaves the DB resumable, never half-written', async () => {
  const client = makeClient(nChunks(4));
  let calls = 0;
  const provider = {
    name: 'jina',
    modelId: () => 'jina-embeddings-v3',
    async embedBatch(texts) {
      calls++;
      if (calls === 1) return texts.map(() => [0.1, 0.2, 0.3]); // probe succeeds
      if (calls === 2) return texts.map(() => [0.4, 0.5, 0.6]); // first batch lands
      throw new EmbeddingError('EMBEDDING_NETWORK', true); // then the vendor dies
    },
  };
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /EMBEDDING_NETWORK/
  );
  assert.equal(client.state.updatesApplied, 2, 'committed work persists');
  assert.equal(client.state.chunks.filter((c) => c.embedding === null).length, 2, 'the rest stay NULL');
});

// ============================================================================
// O. query-time failure: honest fall back to real FTS
// ============================================================================

function makeRow(overrides = {}) {
  return {
    id: 'chunk-x', book_id: 'book-1', edition_id: 'ed-1', book_source_id: 'src-1',
    page_id: 'page-1', chunk_uid: 'uid-x', page_start: 1, page_end: 1, chapter: null,
    source_text: 'text', search_text: 'text', spans: [], coordinates_available: false,
    ...overrides,
  };
}

function pipelineRunQuery({ vectorRows, lexicalRows }) {
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
    return { rows: [] };
  };
}

test('O: a query-embedding failure degrades to lexical-only, it never fakes a vector', async () => {
  const runQuery = pipelineRunQuery({
    vectorRows: [],
    lexicalRows: [makeRow({ id: 'a', rank: 0.4, page_start: 12, source_text: 'Ivan on God.' })],
  });
  const failing = { embedBatch: async () => { throw new EmbeddingError('EMBEDDING_NETWORK', true); } };
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What does Ivan say about God?' },
    {
      runQuery,
      makeProvider: () => failing,
      reranker: null,
      groq: async () => JSON.stringify({ answer: 'Ivan rejects God.', evidenceIds: ['e1'], confidence: 'supported' }),
    }
  );
  assert.equal(res.status, 'ok', 'the answer came from real full-text hits');
  assert.equal(res.debug.vectorUnavailable, true);
  assert.equal(res.debug.counts.vector, 0, 'no vector candidates are claimed');
  assert.equal(res.debug.counts.lexical, 1);
  assert.equal(res.citations[0].page, 12, 'citations still come from the DB row');
});

test('O2: a provider configured for a different dimension cannot query the index', async () => {
  const provider = jinaProvider({ dim: 1024 });
  await assert.rejects(
    () => embedQuery(provider, 'what does Ivan say?', { expectedDim: 384 }),
    (e) => String(e.code).startsWith('EMBEDDING_DIM_MISMATCH')
  );
});

// ============================================================================
// P/Q/R. vector retrieval, RRF and citations with real Jina-dim vectors
// ============================================================================

test('P: a Jina query vector drives scoped pgvector search with real scores', async () => {
  let captured = null;
  const runQuery = async (sql, params) => {
    captured = { sql, params };
    return { rows: [makeRow({ id: 'a', distance: 0.25 }), makeRow({ id: 'b', distance: 0.6 })] };
  };
  const vector = (await jinaProvider({ dim: 384 }).embedBatch(['what does Ivan say?']))[0];
  const out = await vectorRetrieval({ vector, bookId: 'book-9', editionId: 'ed-9', sourceId: 'src-9', runQuery });
  assert.equal(captured.params[0].split(',').length, 384, 'the bound literal has the real dimension');
  assert.match(captured.sql, /c\.book_id = \$2 AND c\.edition_id = \$3 AND c\.embedding IS NOT NULL/);
  assert.ok(!captured.sql.includes(vector[0].toString()), 'the vector is bound, never interpolated');
  assert.equal(out[0].retrieval.vectorRank, 1);
  assert.ok(Math.abs(out[0].retrieval.vectorScore - 0.75) < 1e-9);
});

test('Q: RRF fuses a Jina vector hit with a lexical hit without inventing scores', () => {
  const cand = (id, retrieval) => ({ ...rowToCandidate(makeRow({ id })), retrieval });
  const fused = rrfFusion(
    [cand('a', { vectorRank: 1, vectorScore: 0.81 }), cand('b', { vectorRank: 2, vectorScore: 0.7 })],
    [cand('b', { lexicalRank: 1, lexicalScore: 0.5 })],
    { k: 60, vectorWeight: 1, lexicalWeight: 1 }
  );
  assert.deepEqual(fused.map((c) => c.chunkId), ['b', 'a']);
  const b = fused[0];
  assert.ok(Math.abs(b.hybridScore - (1 / 62 + 1 / 61)) < 1e-9, 'fused score is computed, not made up');
  assert.equal(b.retrieval.vectorScore, 0.7);
  assert.equal(b.retrieval.lexicalScore, 0.5);
});

test('R: with Jina vectors present, citations still resolve to DB page/text', async () => {
  const runQuery = pipelineRunQuery({
    vectorRows: [makeRow({ id: 'a', distance: 0.15, page_start: 231, source_text: 'Every one of them.' })],
    lexicalRows: [],
  });
  const provider = jinaProvider({ dim: env.embeddingDim });
  const res = await researchQuery(
    { userId: 'u', conversationId: 'c', bookId: 'b', editionId: 'e', message: 'What does Alyosha believe?' },
    {
      runQuery,
      makeProvider: () => provider,
      reranker: null,
      groq: async () => JSON.stringify({ answer: 'He believes.', evidenceIds: ['e1'], confidence: 'supported' }),
    }
  );
  assert.equal(res.debug.vectorUnavailable, false, 'the vector leg really ran');
  assert.equal(res.debug.counts.vector, 1);
  assert.equal(res.citations.length, 1);
  assert.equal(res.citations[0].page, 231);
  assert.equal(res.citations[0].text, 'Every one of them.');
});

// ============================================================================
// S + §19 crash safety. Boot, config and secret hygiene
// ============================================================================

test('S / case A: the server boots and health stays honest while Jina is unavailable', async () => {
  const saved = { name: env.embeddingProvider, key: env.jinaApiKey, model: env.jinaEmbeddingModel };
  env.embeddingProvider = 'jina';
  env.jinaApiKey = '';
  env.jinaEmbeddingModel = '';
  try {
    assert.equal(embeddingConfigured(), false);
    assert.equal(embeddingProviderInfo().provider, 'jina');
    assert.throws(() => makeEmbeddingProvider(), (e) => e.code === 'EMBEDDING_NOT_CONFIGURED');
    const { createApp } = await import('../src/app.js');
    const server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const base = `http://127.0.0.1:${server.address().port}/api`;
      const res = await fetch(`${base}/health`);
      assert.equal(res.status, 200, 'an unavailable vendor never breaks health');
      const body = await res.json();
      assert.equal(body.embeddingProvider.provider, 'jina');
      assert.equal(body.embeddingProvider.configured, false);
      assert.equal(typeof body.vectorIndex.configured, 'boolean');
      assert.equal(typeof body.vectorIndex.populated, 'boolean');
      // No live Jina call is made from health, and no key material leaks.
      assert.equal(body.embeddingProvider.reachable, 'not_probed_on_health_path');
      assert.ok(!/jina_|api\.jina\.ai/i.test(JSON.stringify(body)));
    } finally {
      server.close();
    }
  } finally {
    Object.assign(env, { embeddingProvider: saved.name, jinaApiKey: saved.key, jinaEmbeddingModel: saved.model });
  }
});

test('S2 / case B: a rerun after a crash re-embeds only the remaining NULL rows', async () => {
  const client = makeClient(nChunks(5), { failUpdateIds: ['c5'] });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: jinaProvider({ dim: 3 }), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /WRITE_FAILED/
  );
  const embedded = client.state.chunks.filter((c) => c.embedding != null).length;
  assert.ok(embedded > 0, 'earlier committed batches survive the crash');
  const provider = jinaProvider({ dim: 3 });
  const requested = [];
  const wrapped = {
    name: 'jina',
    modelId: () => 'jina-embeddings-v3',
    async embedBatch(texts) { requested.push(texts.length); return provider.embedBatch(texts); },
  };
  const r = await embedSource({ slug: 'b', edition: 'e', provider: wrapped, connect: connectTo(client), config: cfg, expectedDim: 3 });
  assert.equal(r.embedded, 5);
  assert.equal(r.nullEmbeddings, 0);
  assert.equal(requested.slice(1).reduce((a, b) => a + b, 0), 5 - embedded, 'no chunk is re-embedded');
});

test('case C: a dimension mismatch mid-job is reported, schema left untouched', async () => {
  const client = makeClient(nChunks(4));
  let calls = 0;
  const provider = {
    name: 'jina',
    modelId: () => 'jina-embeddings-v3',
    async embedBatch(texts) {
      calls++;
      // Probe says 3; a later response quietly comes back at 4.
      return texts.map(() => Array.from({ length: calls === 1 ? 3 : 4 }, (_, i) => i / 10));
    },
  };
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /EMBEDDING_INCONSISTENT_DIM|EMBEDDING_DIM_MISMATCH/
  );
  assert.equal(client.state.updatesApplied, 0);
});

test('case D: the advisory lock is released even when the job throws', async () => {
  const client = makeClient(nChunks(3));
  let released = false;
  client.release = () => { released = true; };
  await assert.rejects(
    () => embedSource({
      slug: 'b', edition: 'e', config: cfg, expectedDim: 3, connect: connectTo(client),
      provider: makeProvider({ fail: new EmbeddingError('EMBEDDING_NETWORK', true), name: 'jina' }),
    }),
    (e) => e.code === 'EMBEDDING_PROVIDER_UNAVAILABLE'
  );
  assert.equal(released, true, 'no leaked connection, so no leaked lock');
});

// ============================================================================
// Vendor selection + secret hygiene
// ============================================================================

test('EMBEDDING_PROVIDER selects the vendor; the default stays huggingface', () => {
  const saved = {
    embeddingProvider: env.embeddingProvider,
    jinaApiKey: env.jinaApiKey,
    jinaEmbeddingModel: env.jinaEmbeddingModel,
    hfApiKey: env.hfApiKey,
    hfEmbeddingModel: env.hfEmbeddingModel,
  };
  try {
    env.embeddingProvider = 'jina';
    env.jinaApiKey = KEY;
    env.jinaEmbeddingModel = 'jina-embeddings-v3';
    assert.equal(embeddingConfigured(), true);
    assert.equal(embeddingProviderInfo().provider, 'jina');
    assert.equal(makeEmbeddingProvider().name, 'jina');

    env.embeddingProvider = 'huggingface';
    env.hfApiKey = 'hf-key';
    env.hfEmbeddingModel = 'hf-model';
    assert.ok(makeEmbeddingProvider() instanceof HuggingFaceEmbeddingProvider);

    env.embeddingProvider = 'jina';
    env.jinaApiKey = '';
    assert.equal(embeddingConfigured(), false, 'a half-configured vendor is not "configured"');
    assert.throws(() => makeEmbeddingProvider(), (e) => e.code === 'EMBEDDING_NOT_CONFIGURED');
  } finally {
    Object.assign(env, saved);
  }
});

test('no provider error or message ever carries the API key', async () => {
  const provider = jinaProvider({ fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${KEY}`); } });
  await assert.rejects(
    () => provider.embedBatch(['x']),
    (e) => {
      assert.equal(e.code, 'EMBEDDING_NETWORK');
      assert.ok(!JSON.stringify({ code: e.code, message: e.message }).includes(KEY));
      return true;
    }
  );
});
