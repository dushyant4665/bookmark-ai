import { env } from '../config/env.js';

// Central ingestion configuration + version stamps.
// parser/chunker versions are part of every deterministic chunk hash, so bumping
// them intentionally re-chunks; they must NOT change silently.
export const PARSER_VERSION = 'pdfjs-dist-v4/v1';
export const CHUNKER_VERSION = 'doc-aware-v1';
export const NORMALIZER_VERSION = 'norm-v1';

export const ingestConfig = {
  chunkTargetTokens: env.ingest.chunkTargetTokens,
  chunkMaxTokens: env.ingest.chunkMaxTokens,
  chunkOverlapTokens: env.ingest.chunkOverlapTokens,
  embeddingBatchSize: env.ingest.embeddingBatchSize,
  embeddingRetries: env.ingest.embeddingRetries,
  embeddingRetryBaseMs: env.ingest.embeddingRetryBaseMs,
  embeddingTimeoutMs: env.ingest.embeddingTimeoutMs,
  embeddingConcurrency: env.ingest.embeddingConcurrency,
  dbWriteBatchSize: env.ingest.dbWriteBatchSize,
  // Minimum tokens before a chunk is worth keeping (drops header/footer fragments).
  minChunkTokens: 20,
};
