import { env, embeddingReady } from '../config/env.js';
import { ingestConfig } from './config.js';

// Embedding provider is abstracted so the ingestion pipeline never binds to one
// vendor:   EmbeddingProvider { HuggingFaceEmbeddingProvider, JinaEmbeddingProvider }
// EMBEDDING_PROVIDER selects the vendor. The real model comes only from that
// vendor's *_EMBEDDING_MODEL env var — never hardcoded — and its output
// dimension is measured from the live response, never assumed.

export class EmbeddingError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
}

// Shared transport classification: every vendor call is bounded by a real
// timeout and maps network/HTTP failures onto retryable EmbeddingErrors, so a
// hung or rate-limited provider can never stall a job or a chat request.
async function postJson(url, { apiKey, body, timeoutMs, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // A fired timeout surfaces as TimeoutError/AbortError; anything else
    // (DNS ENOTFOUND, ECONNREFUSED/RESET, ETIMEDOUT) is a plain network
    // failure. Both are transient/retryable but we keep the codes distinct.
    const name = err?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new EmbeddingError('EMBEDDING_TIMEOUT', true);
    }
    throw new EmbeddingError('EMBEDDING_NETWORK', true);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new EmbeddingError(`EMBEDDING_HTTP_${res.status}`, true);
  }
  // 400-class (bad key, bad model, bad payload) is not retryable: repeating it
  // would only burn the quota budget.
  if (!res.ok) throw new EmbeddingError(`EMBEDDING_HTTP_${res.status}`, false);
  const json = await res.json().catch(() => null);
  return json;
}

export class HuggingFaceEmbeddingProvider {
  name = 'huggingface';
  constructor({ apiKey, model, retryBaseMs = 500, timeoutMs = 30000, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.retryBaseMs = retryBaseMs;
    // Every provider request is bounded — a hung socket can never stall the job
    // or the query path (§4/§5: no hanging provider requests).
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }
  modelId() {
    return this.model;
  }
  // Sends one batch; a batch is an array of strings -> array of vectors.
  async embedBatch(texts) {
    const url = `https://api-inference.huggingface.co/models/${this.model}`;
    const body = { inputs: texts, options: { wait_for_model: true } };
    const doFetch = async () => {
      const json = await postJson(url, {
        apiKey: this.apiKey,
        body,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetch,
      });
      if (json && typeof json.error === 'string') throw new EmbeddingError('EMBEDDING_MODEL_ERROR', true);
      return json;
    };
    const json = await withBoundedRetry(doFetch, ingestConfig.embeddingRetries, this.retryBaseMs);
    return normalizeResponse(json, texts.length);
  }
}

// Jina AI embeddings. Same contract as the HF provider (texts -> vectors), so
// nothing downstream — probe, batching, validation, backfill, query path —
// changes when the vendor does.
//   POST https://api.jina.ai/v1/embeddings { model, input: [..], dimensions? }
//   -> { data: [ { index, embedding: [..] } ], model, usage }
// `dimensions` is requested so the model emits exactly the width the pgvector
// column already has (EMBEDDING_DIM) — no schema migration, no truncation on our
// side. It is only a request: probeDimension() still measures what came back,
// and the job refuses to write anything if the real width differs.
// `task` is deliberately left unset: ingestion and query must land in ONE vector
// space, so both legs get the identical symmetric call.
export class JinaEmbeddingProvider {
  name = 'jina';
  constructor({ apiKey, model, dimensions = null, retryBaseMs = 500, timeoutMs = 30000, fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = Number.isInteger(dimensions) && dimensions > 0 ? dimensions : null;
    this.retryBaseMs = retryBaseMs;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }
  modelId() {
    return this.model;
  }
  async embedBatch(texts) {
    const body = { model: this.model, input: texts };
    if (this.dimensions) body.dimensions = this.dimensions;
    const doFetch = async () => {
      const json = await postJson('https://api.jina.ai/v1/embeddings', {
        apiKey: this.apiKey,
        body,
        timeoutMs: this.timeoutMs,
        fetchImpl: this.fetch,
      });
      if (json && !Array.isArray(json.data) && typeof json.error === 'string') {
        throw new EmbeddingError('EMBEDDING_MODEL_ERROR', true);
      }
      return json;
    };
    const json = await withBoundedRetry(doFetch, ingestConfig.embeddingRetries, this.retryBaseMs);
    return normalizeJinaResponse(json, texts.length);
  }
}

// Jina's envelope: one {index, embedding} item per input string. Restored in
// input order so a batch response can never be written against the wrong chunk.
export function normalizeJinaResponse(json, expectedCount) {
  const data = json?.data;
  if (!Array.isArray(data)) throw new EmbeddingError('EMBEDDING_MALFORMED_RESPONSE');
  const items = data.map((d, i) => ({
    index: Number.isInteger(d?.index) ? d.index : i,
    vector: Array.isArray(d?.embedding) ? d.embedding : d,
  }));
  if (items.length !== expectedCount) throw new EmbeddingError('EMBEDDING_COUNT_MISMATCH');
  items.sort((a, b) => a.index - b.index);
  return items.map((it) => it.vector);
}

// Turn a provider response into one flat vector per input, or fail loudly.
export function normalizeResponse(json, expectedCount) {
  let arr = json;
  // Common shapes: [[...]], [ [..],[..] ], or a single flat vector.
  if (!Array.isArray(arr)) throw new EmbeddingError('EMBEDDING_MALFORMED_RESPONSE');
  if (expectedCount === 1 && arr.length && !Array.isArray(arr[0])) arr = [arr];
  if (arr.length !== expectedCount) {
    // A single-vector response echoed back for a batch of 1.
    if (expectedCount === 1) arr = [arr];
    else throw new EmbeddingError('EMBEDDING_COUNT_MISMATCH');
  }
  return arr.map((v) => (Array.isArray(v) && !Array.isArray(v[0]) ? v : v));
}

// Validate real vectors before they ever reach the database. Never fabricate.
export function validateVectors(vectors, expectedDim) {
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new EmbeddingError('EMBEDDING_EMPTY');
  }
  let dim = null;
  for (const v of vectors) {
    if (!Array.isArray(v) || v.length === 0) throw new EmbeddingError('EMBEDDING_MALFORMED_VECTOR');
    if (dim === null) dim = v.length;
    else if (v.length !== dim) throw new EmbeddingError('EMBEDDING_INCONSISTENT_DIM');
    for (const x of v) {
      if (typeof x !== 'number' || Number.isNaN(x)) throw new EmbeddingError('EMBEDDING_NAN');
      if (!Number.isFinite(x)) throw new EmbeddingError('EMBEDDING_INFINITY');
    }
  }
  if (expectedDim != null && dim !== expectedDim) {
    throw new EmbeddingError(`EMBEDDING_DIM_MISMATCH:${dim}!=${expectedDim}`);
  }
  return dim;
}

// Detect the model's ACTUAL output dimension from a live probe — never assumed.
export async function probeDimension(provider) {
  const [vec] = await provider.embedBatch(['dimension probe']);
  if (!Array.isArray(vec) || vec.length === 0) throw new EmbeddingError('EMBEDDING_PROBE_FAILED');
  validateVectors([vec], null);
  return vec.length;
}

export async function withBoundedRetry(fn, retries, baseMs) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (!err.retryable || attempt > retries) throw err;
      const delay = baseMs * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export function embeddingConfigured() {
  return embeddingReady();
}

// What the selected vendor is and whether its env is complete. Used by health
// and verify:production so neither one re-implements the selection rule. The
// model name is a public identifier; the key is never included anywhere.
export function embeddingProviderInfo() {
  return {
    provider: env.embeddingProvider,
    configured: embeddingReady(),
    model: env.embeddingProvider === 'jina' ? env.jinaEmbeddingModel : env.hfEmbeddingModel,
  };
}

export function embeddingSetupHint() {
  return env.embeddingProvider === 'jina'
    ? 'EMBEDDING_PROVIDER=jina requires JINA_API_KEY and JINA_EMBEDDING_MODEL'
    : 'EMBEDDING_PROVIDER=huggingface requires HUGGINGFACE_API_KEY and HF_EMBEDDING_MODEL';
}

export function makeEmbeddingProvider() {
  if (!embeddingReady()) {
    throw new EmbeddingError('EMBEDDING_NOT_CONFIGURED');
  }
  const shared = {
    retryBaseMs: env.ingest.embeddingRetryBaseMs,
    timeoutMs: env.ingest.embeddingTimeoutMs,
  };
  if (env.embeddingProvider === 'jina') {
    return new JinaEmbeddingProvider({
      apiKey: env.jinaApiKey,
      model: env.jinaEmbeddingModel,
      dimensions: env.embeddingDim,
      ...shared,
    });
  }
  return new HuggingFaceEmbeddingProvider({ apiKey: env.hfApiKey, model: env.hfEmbeddingModel, ...shared });
}

// Chunk texts -> validated vectors, in configurable batches.
export async function embedInBatches(provider, texts, { expectedDim, batchSize = ingestConfig.embeddingBatchSize, onBatch } = {}) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const raw = await provider.embedBatch(batch);
    const dim = validateVectors(raw, expectedDim);
    vectors.push(...raw);
    onBatch?.({ start: i, count: batch.length, total: texts.length, dim });
  }
  return vectors;
}

// Phase 3: embed a single query for retrieval. Reuses the SAME provider +
// validation as ingestion so query and document vectors are always comparable.
export async function embedQuery(provider, text, { expectedDim } = {}) {
  const [vector] = await provider.embedBatch([text]);
  validateVectors([vector], expectedDim ?? env.embeddingDim);
  return vector;
}
