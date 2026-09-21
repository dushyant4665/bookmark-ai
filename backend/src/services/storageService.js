import { createReadStream } from 'node:fs';
import { stat, mkdir, copyFile, access } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { constants } from 'node:fs';
import { resolve, sep, dirname } from 'node:path';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

// Storage abstraction. Callers (routes + ingestion) only ever speak in terms of
// book/edition ids or a storage key — never an absolute host path.
//
//   StorageProvider
//     ├── LocalStorageProvider    (STORAGE_BACKEND=local, development)
//     └── SupabaseStorageProvider (STORAGE_BACKEND=supabase, production)
//
// Both expose the SAME contract so the PDF route is backend-agnostic:
//   keyFor(slug, edition) -> stable relative storage key (never a host path)
//   exists(key) -> boolean
//   open(key, { range }) -> { stream, fileSize, status?, contentRange?, acceptRanges? }
//   put(key, sourceFilePath) -> { storageKey, byteSize }   (ingest-time upload)

function safeJoin(relKey) {
  const base = resolve(env.storageLocalDir);
  const target = resolve(base, relKey);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('STORAGE_PATH_ESCAPE');
  }
  return target;
}

class LocalStorageProvider {
  name = 'local';
  // Convention: <slug>/<edition>/source.pdf — a relative, POSIX-style key that
  // is portable across OSes (never an absolute host path).
  keyFor(bookSlug, editionLabel) {
    return [String(bookSlug), String(editionLabel), 'source.pdf'].join('/');
  }
  async exists(storageKey) {
    try {
      await access(safeJoin(storageKey), constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
  async open(storageKey, { range } = {}) {
    const path = safeJoin(storageKey);
    const info = await stat(path);
    const fileSize = Number(info.size);
    if (range) {
      const { start, end } = clampRange(range, fileSize);
      return {
        stream: createReadStream(path, { start, end }),
        fileSize,
        contentLength: end - start + 1,
        status: 206,
        contentRange: `bytes ${start}-${end}/${fileSize}`,
        acceptRanges: 'bytes',
      };
    }
    return { stream: createReadStream(path), fileSize, contentLength: fileSize, acceptRanges: 'bytes' };
  }
  // Copies an already-uploaded file into the managed store and returns metadata.
  async put(storageKey, sourceFilePath) {
    const dest = safeJoin(storageKey);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(sourceFilePath, dest);
    const info = await stat(dest);
    return { storageKey, byteSize: Number(info.size) };
  }
}

function clampRange(range, fileSize) {
  let { start = 0, end = fileSize - 1 } = range;
  if (Number.isNaN(start) || start < 0) start = 0;
  if (Number.isNaN(end) || end >= fileSize) end = fileSize - 1;
  if (start > end) start = end;
  return { start, end };
}

// Parses a single "bytes=start-end" Range header (only the first range).
function parseRangeHeader(header, fileSize) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return null;
  let [, startStr, endStr] = m;
  if (startStr === '' && endStr === '') return null;
  if (startStr === '') {
    // suffix range: last N bytes
    const n = Number(endStr);
    if (!Number.isFinite(n) || n <= 0) return null;
    return { start: Math.max(0, fileSize - n), end: fileSize - 1 };
  }
  const start = Number(startStr);
  const end = endStr === '' ? fileSize - 1 : Number(endStr);
  if (!Number.isFinite(start) || start >= fileSize) return { start: 0, end: -1 }; // unsatisfiable
  return { start, end };
}

class SupabaseStorageProvider {
  name = 'supabase';
  constructor({ url, serviceKey, bucket } = {}) {
    this.url = url || env.supabaseUrl;
    this.base = String(this.url).replace(/\/+$/, '');
    this.serviceKey = serviceKey || env.supabaseServiceRoleKey;
    this.bucket = bucket || env.supabaseStorageBucket;
    if (!this.url || !this.serviceKey || !this.bucket) {
      throw new Error('STORAGE_BACKEND_NOT_READY');
    }
  }
  keyFor(bookSlug, editionLabel) {
    return [String(bookSlug), String(editionLabel), 'source.pdf'].join('/');
  }
  // Private bucket: authenticated object endpoint for READS, service-role key
  // stays here (backend only). Never handed to the browser.
  objectUrl(storageKey) {
    const key = String(storageKey).split(sep).join('/');
    return `${this.base}/storage/v1/object/authenticated/${this.bucket}/${key}`;
  }
  // Uploads/uploads use the plain object endpoint (the `authenticated` prefix is
  // read-only on the Supabase Storage REST API).
  uploadUrl(storageKey) {
    const key = String(storageKey).split(sep).join('/');
    return `${this.base}/storage/v1/object/${this.bucket}/${key}`;
  }
  authHeaders() {
    return {
      authorization: `Bearer ${this.serviceKey}`,
      // Ask Supabase not to hand us its own gzip of an already-compressed PDF.
      'accept-encoding': 'identity',
    };
  }
  async exists(storageKey) {
    const res = await fetch(this.objectUrl(storageKey), { method: 'HEAD', headers: this.authHeaders() });
    return res.ok;
  }
  async info(storageKey) {
    const res = await fetch(this.objectUrl(storageKey), { method: 'HEAD', headers: this.authHeaders() });
    if (!res.ok) throw new Error('STORAGE_OBJECT_NOT_FOUND');
    const len = Number(res.headers.get('content-length'));
    return { byteSize: Number.isFinite(len) ? len : null };
  }
  async open(storageKey, { range } = {}) {
    const headers = { ...this.authHeaders() };
    if (range) headers.range = `bytes=${range.start}-${range.end}`;
    const res = await fetch(this.objectUrl(storageKey), { method: 'GET', headers });
    if (res.status === 404) throw new Error('STORAGE_OBJECT_NOT_FOUND');
    if (!res.ok && res.status !== 206) throw new Error(`STORAGE_UPSTREAM_${res.status}`);
    if (!res.body) throw new Error('STORAGE_EMPTY_RESPONSE');
    const stream = Readable.fromWeb(res.body);
    const contentRange = res.headers.get('content-range');
    const upstreamLen = Number(res.headers.get('content-length'));
    const fileSize = contentRange
      ? Number(contentRange.split('/')[1])
      : Number.isFinite(upstreamLen) ? upstreamLen : null;
    return {
      stream,
      fileSize,
      contentLength: Number.isFinite(upstreamLen) ? upstreamLen : null,
      status: res.status === 206 ? 206 : 200,
      contentRange: contentRange || undefined,
      acceptRanges: 'bytes',
    };
  }
  async put(storageKey, sourceFilePath) {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(sourceFilePath);
    const res = await fetch(this.uploadUrl(storageKey), {
      method: 'POST',
      headers: { ...this.authHeaders(), 'content-type': 'application/pdf', 'x-upsert': 'true' },
      body: buf,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const e = new Error(`STORAGE_UPLOAD_${res.status}`);
      e.detail = detail.slice(0, 200);
      throw e;
    }
    return { storageKey, byteSize: buf.length };
  }
}

export function makeStorageProvider(backend = env.storageBackend) {
  if (backend === 'local') return new LocalStorageProvider();
  if (backend === 'supabase') return new SupabaseStorageProvider();
  throw new Error('STORAGE_BACKEND_UNSUPPORTED');
}

// Resolves the exact source row for an edition and returns a readable stream.
// Accepts an optional raw Range header so PDF.js byte-range requests pass
// straight through to the provider (no full-file download per render).
export async function getBookPdf(bookId, editionId, { rangeHeader } = {}) {
  const { rows } = await query(
    `SELECT bs.id, bs.storage_backend, bs.storage_key, bs.mime_type, bs.original_filename, bs.sha256
       FROM book_sources bs
       JOIN book_editions be ON be.id = bs.edition_id
      WHERE bs.edition_id = $1 AND be.book_id = $2
      LIMIT 1`,
    [editionId, bookId]
  );
  const rec = rows[0];
  if (!rec) return null;

  const provider = makeStorageProvider(rec.storage_backend);
  // Only probe size for a full (non-range) request so a range request doesn't
  // pay for an extra round-trip; the provider reports fileSize from headers.
  let range;
  if (rangeHeader) {
    const size = await provider.info?.(rec.storage_key).then((i) => i.byteSize).catch(() => null);
    range = size ? parseRangeHeader(rangeHeader, size) : null;
  }
  const opened = await provider.open(rec.storage_key, { range });
  return {
    stream: opened.stream,
    fileSize: opened.fileSize,
    contentLength: opened.contentLength,
    status: opened.status,
    contentRange: opened.contentRange,
    acceptRanges: opened.acceptRanges,
    mimeType: rec.mime_type || 'application/pdf',
    originalFilename: rec.original_filename || 'book.pdf',
    sha256: rec.sha256,
  };
}

// §7 source/PDF integrity: recompute the stored object's SHA-256 and compare it
// to book_sources.sha256. A mismatch means the displayed PDF is NOT the indexed
// one, which would silently break citation highlighting — so we refuse to call
// it ready. Used by the production verify script, not the per-request path.
export async function verifySourceIntegrity(bookId, editionId) {
  const { createHash } = await import('node:crypto');
  const pdf = await getBookPdf(bookId, editionId);
  if (!pdf) return { ok: false, code: 'SOURCE_NOT_FOUND' };
  const hash = createHash('sha256');
  await new Promise((resolveP, rejectP) => {
    pdf.stream.on('data', (c) => hash.update(c));
    pdf.stream.on('end', resolveP);
    pdf.stream.on('error', rejectP);
  });
  const actual = hash.digest('hex');
  if (!pdf.sha256) return { ok: false, code: 'SOURCE_HASH_MISSING', actual };
  if (actual !== pdf.sha256) return { ok: false, code: 'SOURCE_VERSION_MISMATCH', actual, expected: pdf.sha256 };
  return { ok: true, sha256: actual };
}

export async function fileExists(absPath) {
  try {
    await access(absPath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
