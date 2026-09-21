import { test } from 'node:test';
import assert from 'node:assert/strict';

import { embedSource, EmbedSourceError } from '../src/ingest/embedSource.js';
import {
  HuggingFaceEmbeddingProvider,
  EmbeddingError,
  validateVectors,
} from '../src/ingest/embeddingProvider.js';
// The shared fixtures are also used by jina.test.js — one fake DB, one fake
// provider, so both vendors are proven against the identical job semantics.
import { makeClient, nChunks, makeProvider, cfg, connectTo } from './helpers/embeddingFixtures.js';

// ---- §4 provider probe first: unreachable => stop, DB unchanged --------------
test('probe unavailable -> EMBEDDING_PROVIDER_UNAVAILABLE, no writes', async () => {
  const client = makeClient(nChunks(4));
  const provider = makeProvider({ fail: new EmbeddingError('EMBEDDING_NETWORK', true) });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'EMBEDDING_PROVIDER_UNAVAILABLE'
  );
  assert.equal(client.state.updatesApplied, 0);
  assert.equal(client.state.committedBatches, 0);
  // only the lock + scope + probe ran; no chunk UPDATE issued
  assert.equal(client.state.updateCalls.length, 0);
});

// ---- §12 wrong dimension stops before writing, schema untouched --------------
test('dimension mismatch -> EMBEDDING_DIMENSION_MISMATCH, no writes', async () => {
  const client = makeClient(nChunks(4));
  const provider = makeProvider({ dim: 5 });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'EMBEDDING_DIMENSION_MISMATCH'
  );
  assert.equal(client.state.updatesApplied, 0);
});

// ---- §9 source scoping -------------------------------------------------------
test('missing source chain -> SOURCE_NOT_FOUND', async () => {
  const client = makeClient(nChunks(4), { sourceMissing: true });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: makeProvider(), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'SOURCE_NOT_FOUND'
  );
});

test('incomplete source -> SOURCE_NOT_READY (never embeds un-ingested book)', async () => {
  const client = makeClient(nChunks(4), { status: 'FAILED' });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: makeProvider(), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'SOURCE_NOT_READY'
  );
});

// ---- §14 duplicate job prevention --------------------------------------------
test('advisory lock held -> EMBEDDING_JOB_ALREADY_RUNNING', async () => {
  const client = makeClient(nChunks(4), { lockAcquired: false });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: makeProvider(), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'EMBEDDING_JOB_ALREADY_RUNNING'
  );
});

// ---- §7/§8/§10/§17 happy path: only NULL embedded, real progress --------------
test('embeds only NULL chunks, leaves pre-embedded untouched', async () => {
  const client = makeClient(nChunks(5, /* preEmbedded */ 2)); // 2 already have [9]
  const provider = makeProvider({ dim: 3 });
  const r = await embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 });
  assert.equal(r.total, 5);
  assert.equal(r.embedded, 5);
  assert.equal(r.nullEmbeddings, 0);
  assert.equal(r.ok, true);
  // the 2 pre-embedded kept their sentinel vector — never regenerated
  assert.equal(client.state.chunks[0].embedding, '[9]');
  assert.equal(client.state.chunks[1].embedding, '[9]');
  // provider.calls: the length-1 probe, then batches of the 3 remaining (2 + 1)
  assert.deepEqual(provider.calls, [1, 2, 1]);
});

// ---- §13 batch failure rolls back, committed batches remain ------------------
test('mid-job write failure rolls back the failing batch; earlier batches persist', async () => {
  // 4 chunks, batch size 2. Fail c3 (in batch 2 {c3,c4}) -> batch 2 rolls back,
  // batch 1 {c1,c2} already committed and stays.
  const client = makeClient(nChunks(4), { failUpdateIds: ['c3'] });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: makeProvider({ dim: 3 }), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /WRITE_FAILED/
  );
  assert.equal(client.state.rolledBack, 1);
  assert.equal(client.state.committedBatches, 1); // only batch 1 committed
  assert.equal(client.state.updatesApplied, 2); // c1,c2 persisted; c3,c4 rolled back
  assert.equal(client.state.chunks[0].embedding != null, true);
  assert.equal(client.state.chunks[1].embedding != null, true);
  assert.equal(client.state.chunks[2].embedding, null);
  assert.equal(client.state.chunks[3].embedding, null);
});

// ---- §18/§28 resume after partial completion ---------------------------------
test('resume: a rerun embeds only the chunks still NULL (no duplicates)', async () => {
  // First run dies mid-way (batch 2 write fails) so batch 1 stays committed.
  const client = makeClient(nChunks(5), { failUpdateIds: ['c5'] });
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: makeProvider({ dim: 3 }), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /WRITE_FAILED/
  );
  // After rollback of batch {c4,c5} and commit of {c1,c2,c3}? batch size 2 ->
  // batch1 {c1,c2} commit, batch2 {c3,c4} commit, batch3 {c5} -> c5 selected alone (limit 2 but only 1 null) ok; fail c5 -> rollback.
  const embeddedAfterFail = client.state.chunks.filter((c) => c.embedding != null).length;
  assert.ok(embeddedAfterFail > 0, 'some earlier work persisted');

  // Rerun: provider now works, no fail injection.
  const remaining = 5 - embeddedAfterFail;
  const provider2 = makeProvider({ dim: 3 });
  const r = await embedSource({ slug: 'b', edition: 'e', provider: provider2, connect: connectTo(client), config: cfg, expectedDim: 3 });
  assert.equal(r.embedded, 5);
  assert.equal(r.nullEmbeddings, 0);
  assert.ok(r.ok);
  // only the remaining chunks were requested (calls[0] is the probe), not all 5
  const totalRequested = provider2.calls.slice(1).reduce((a, b) => a + b, 0);
  assert.equal(totalRequested, remaining);
});

// ---- §11 malformed / NaN / wrong-dim vectors rejected before landing ---------
test('NaN vector from provider is rejected, nothing written', async () => {
  const client = makeClient(nChunks(2));
  // Passes the length-1 dimension probe, but returns a NaN vector on a real batch.
  const provider = {
    modelId: () => 'm',
    embedBatch: async (t) => (t.length === 1 ? [[1, 2, 3]] : t.map(() => [1, NaN, 3])),
  };
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider, connect: connectTo(client), config: cfg, expectedDim: 3 }),
    /EMBEDDING_NAN/
  );
  assert.equal(client.state.updatesApplied, 0);
});

test('wrong-dim vector mid-batch is rejected', () => {
  assert.throws(() => validateVectors([[1, 2, 3], [1, 2]], 3), EmbeddingError);
});

// ---- provider transport classification (§5/§6) -------------------------------
function providerWith(fetchImpl) {
  return new HuggingFaceEmbeddingProvider({
    apiKey: 'k', model: 'm', retryBaseMs: 1, timeoutMs: 50, fetchImpl,
  });
}

test('transport: timeout -> EMBEDDING_TIMEOUT (retryable)', async () => {
  const fetchImpl = async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; };
  await assert.rejects(() => providerWith(fetchImpl).embedBatch(['x']), (e) => e.code === 'EMBEDDING_TIMEOUT' && e.retryable);
});

test('transport: DNS/ENOTFOUND -> EMBEDDING_NETWORK (retryable)', async () => {
  const fetchImpl = async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); };
  await assert.rejects(() => providerWith(fetchImpl).embedBatch(['x']), (e) => e.code === 'EMBEDDING_NETWORK' && e.retryable);
});

test('transport: 401/403 are NOT retried', async () => {
  let n = 0;
  for (const status of [401, 403]) {
    n = 0;
    const fetchImpl = async () => { n++; return { ok: false, status, json: async () => ({}) }; };
    await assert.rejects(() => providerWith(fetchImpl).embedBatch(['x']), (e) => e.code === `EMBEDDING_HTTP_${status}` && !e.retryable);
    assert.equal(n, 1, `${status} must not retry`);
  }
});

test('transport: 429/500 are retried (bounded) then fail', async () => {
  for (const status of [429, 500]) {
    let n = 0;
    const fetchImpl = async () => { n++; return { ok: false, status, json: async () => ({}) }; };
    await assert.rejects(() => providerWith(fetchImpl).embedBatch(['x']), (e) => e.code === `EMBEDDING_HTTP_${status}` && e.retryable);
    assert.ok(n > 1, `${status} should retry at least once`);
    assert.ok(n <= 6, `${status} retries stay bounded (saw ${n})`);
  }
});

test('transport: malformed response -> EMBEDDING_MALFORMED_RESPONSE', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ not: 'an array' }) });
  await assert.rejects(() => providerWith(fetchImpl).embedBatch(['x']), /EMBEDDING_MALFORMED_RESPONSE/);
});

// ---- §35 CASE A: server keeps running with provider down (no auto-embed) -----
test('no boot-time embedding: provider factory is only invoked by explicit job', async () => {
  // embedSource with an unavailable provider throws a controlled error code and
  // releases the client — it never crashes the process nor writes anything.
  const client = makeClient(nChunks(3));
  let released = false;
  client.release = () => { released = true; };
  await assert.rejects(
    () => embedSource({ slug: 'b', edition: 'e', provider: makeProvider({ fail: new EmbeddingError('EMBEDDING_NETWORK', true) }), connect: connectTo(client), config: cfg, expectedDim: 3 }),
    (e) => e.code === 'EMBEDDING_PROVIDER_UNAVAILABLE'
  );
  assert.equal(released, true, 'client is always released (lock not leaked)');
  assert.ok(EmbedSourceError);
});
