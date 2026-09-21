// Shared fixtures for the embedding-job tests. It understands exactly the SQL
// shapes embedSource issues, so the tests prove the real control flow
// (lock -> scope -> probe -> only-NULL select -> batched txn -> resume) without
// touching a database or a network.

// A tiny in-memory stand-in for the pg client.
export function makeClient(chunks, opts = {}) {
  const state = {
    chunks: chunks.map((c) => ({ embedding: null, ...c })),
    inTx: false,
    pending: [], // buffered updates for the current transaction
    updatesApplied: 0,
    updateCalls: [],
    committedBatches: 0,
    rolledBack: 0,
    begin: 0,
    allowFail: true,
  };
  const client = {
    state,
    async release() {},
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();

      if (s.includes('pg_try_advisory_lock')) {
        return { rows: [{ key: 1, acquired: opts.lockAcquired !== false }] };
      }
      if (s.includes('pg_advisory_unlock')) return { rows: [] };

      if (s.includes('FROM books b') && s.includes('WHERE b.slug')) {
        if (opts.sourceMissing) return { rows: [] };
        return {
          rows: [{
            book_id: 'b1', edition_id: 'e1', source_id: 's1',
            ingestion_status: opts.status ?? 'COMPLETED',
            embedding_dim: opts.sourceDim ?? null,
          }],
        };
      }
      if (s.includes('UPDATE book_sources SET embedding_model')) return { rows: [] };

      if (s.includes('count(*) FILTER (WHERE embedding IS NOT NULL)')) {
        const embedded = state.chunks.filter((c) => c.embedding != null).length;
        const live = state.chunks.find((c) => c.embedding != null);
        return {
          rows: [{
            total: state.chunks.length,
            embedded,
            live_dim: live ? live.embedding.length : null,
          }],
        };
      }
      if (s.includes('SELECT id, search_text FROM literature_chunks')) {
        const limit = params[1];
        const rows = state.chunks.filter((c) => c.embedding == null).slice(0, limit);
        return { rows };
      }
      if (s === 'BEGIN') { state.inTx = true; state.begin++; state.pending = []; return { rows: [] }; }
      if (s === 'COMMIT') {
        for (const p of state.pending) {
          const c = state.chunks.find((x) => x.id === p.id && x.embedding == null);
          // store as an array so countsFor reports a real vector dimension
          if (c) { c.embedding = JSON.parse(p.vector); state.updatesApplied++; }
        }
        state.committedBatches++;
        state.pending = [];
        state.inTx = false;
        return { rows: [] };
      }
      if (s === 'ROLLBACK') { state.pending = []; state.rolledBack++; state.inTx = false; return { rows: [] }; }

      if (s.includes('UPDATE literature_chunks SET embedding')) {
        const [id, literal] = params;
        state.updateCalls.push(id);
        if (opts.failUpdateIds?.includes(id) && state.allowFail) {
          state.allowFail = false; // fire once so a rerun can succeed
          throw new Error('WRITE_FAILED');
        }
        state.pending.push({ id, vector: literal });
        return { rows: [] };
      }
      throw new Error('FAKE_CLIENT_UNEXPECTED_SQL: ' + s.slice(0, 60));
    },
  };
  return client;
}

export function nChunks(n, preEmbedded = 0) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    const c = { id: `c${i}`, search_text: `text ${i}` };
    if (i <= preEmbedded) c.embedding = `[9]`; // sentinel — must never be touched
    arr.push(c);
  }
  return arr;
}

// ---- fake embedding provider (no network) ------------------------------------
export function makeProvider({ dim = 3, fail, name = 'mock' } = {}) {
  const calls = [];
  return {
    name,
    calls,
    modelId: () => 'mock-model',
    async embedBatch(texts) {
      calls.push(texts.length);
      if (fail) throw fail;
      return texts.map(() => Array.from({ length: dim }, (_, i) => 0.1 + i * 0.01));
    },
  };
}

export const cfg = { embeddingBatchSize: 2, embeddingConcurrency: 1 };
export const connectTo = (client) => async () => client;

// Jina's response envelope, built from the strings we were actually sent so a
// test can assert the batch really maps back to its inputs.
export function jinaPayload(texts, { dim = 3, reorder = false, value = 0.5 } = {}) {
  const items = texts.map((t, i) => ({
    index: i,
    embedding: Array.from({ length: dim }, (_, k) => value + k * 0.001 + t.length * 0.0001),
  }));
  if (reorder) items.reverse();
  return { model: 'mock-jina-model', data: items, usage: { total_tokens: 1 } };
}

export function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
