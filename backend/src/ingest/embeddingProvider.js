import { env } from '../config/env.js';
import { ingestConfig } from './config.js';

// Embedding provider is abstracted so the ingestion pipeline never binds to one
// vendor:   EmbeddingProvider { HuggingFaceEmbeddingProvider, future LocalEmbeddingProvider }
// The real model comes only from HF_EMBEDDING_MODEL — never hardcoded, and its
// output dimension is measured from the live response, never assumed.

export class EmbeddingError extends Error {
  constructor(code, retryable = false) {
    super(code);
    this.code = code;
    this.retryable = retryable;
  }
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
      let res;
      try {
        res = await this.fetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
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
      if (!res.ok) throw new EmbeddingError(`EMBEDDING_HTTP_${res.status}`, false);
      const json = await res.json().catch(() => null);
      if (json && typeof json.error === 'string') throw new EmbeddingError('EMBEDDING_MODEL_ERROR', true);
      return json;
    };
    const json = await withBoundedRetry(doFetch, ingestConfig.embeddingRetries, this.retryBaseMs);
    return normalizeResponse(json, texts.length);
  }
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
  return Boolean(env.hfApiKey && env.hfEmbeddingModel);
}

export function makeEmbeddingProvider() {
  if (!env.hfApiKey || !env.hfEmbeddingModel) {
    throw new EmbeddingError('EMBEDDING_NOT_CONFIGURED');
  }
  return new HuggingFaceEmbeddingProvider({
    apiKey: env.hfApiKey,
    model: env.hfEmbeddingModel,
    retryBaseMs: env.ingest.embeddingRetryBaseMs,
    timeoutMs: env.ingest.embeddingTimeoutMs,
  });
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
