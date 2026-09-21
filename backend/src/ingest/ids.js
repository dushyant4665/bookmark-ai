import { createHash } from 'node:crypto';

// Deterministic identities so retries don't duplicate logical rows.
export function sha256hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// same source + same chunking config => same chunk_uid => safe re-runs.
export function chunkUid({ sourceId, chunkerVersion, chunkIndex, pageNumber, sourceText }) {
  return sha256hex(
    JSON.stringify([sourceId, chunkerVersion, chunkIndex, pageNumber, sourceText])
  );
}

export function jobId(prefix = 'ingest') {
  return `${prefix}_${Date.now().toString(36)}_${createHash('sha1').update(String(Math.random())).digest('hex').slice(0, 8)}`;
}
