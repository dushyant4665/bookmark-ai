import { query } from '../db/pool.js';
import { libraryListing, sha256StoredFile } from './storageService.js';

export async function listBooks() {
  const { rows } = await query(
    `SELECT id, title, author, description, created_at
       FROM books
      ORDER BY title ASC`
  );
  return rows;
}

export async function getBook(bookId) {
  const { rows } = await query(
    `SELECT id, title, author, description, created_at
       FROM books WHERE id = $1`,
    [bookId]
  );
  return rows[0] || null;
}

export async function listEditions(bookId) {
  const { rows } = await query(
    `SELECT be.id, be.label, be.language, be.total_pages,
            bs.id IS NOT NULL AS has_source,
            COALESCE(bs.ingestion_status, 'NOT_INGESTED') AS ingestion_status
       FROM book_editions be
       LEFT JOIN book_sources bs ON bs.edition_id = be.id
      WHERE be.book_id = $1
      ORDER BY be.created_at ASC`,
    [bookId]
  );
  return rows;
}

// Every ingested source, so a storage listing can be joined to real library
// state. Keys are relative and portable, but the dashboard can move a file and
// a dev-only local path never reaches production — hence sha256 as the proof.
async function listSources() {
  const { rows } = await query(
    `SELECT bs.id AS source_id, bs.storage_backend, bs.storage_key, bs.sha256,
            bs.byte_size, bs.page_count, bs.embedding_dim, bs.embedding_model,
            bs.ingestion_status, bs.updated_at,
            b.id AS book_id, b.title, b.author,
            be.id AS edition_id, be.label AS edition_label,
            (SELECT count(*)::int FROM literature_chunks lc WHERE lc.book_source_id = bs.id) AS chunk_count
       FROM book_sources bs
       JOIN book_editions be ON be.id = bs.edition_id
       JOIN books b ON b.id = be.book_id`
  );
  return rows;
}

// A file's bytes are hashed at most once per process, and only when the storage
// key alone cannot identify it. Revalidates when the object is replaced.
const fileHashCache = new Map();

async function fileSha256(backend, key, size, lastModified) {
  const cacheKey = `${backend}:${key}`;
  const stamp = `${size ?? '?'}|${lastModified ?? '?'}`;
  const hit = fileHashCache.get(cacheKey);
  if (hit && hit.stamp === stamp) return hit.sha256;
  const sha256 = await sha256StoredFile(backend, key);
  fileHashCache.set(cacheKey, { stamp, sha256 });
  return sha256;
}

// The dropdown's real source of truth: the library folder in storage (see
// STORAGE_LIBRARY_PREFIX), joined against what has actually been indexed.
// A PDF the user dropped into the bucket appears immediately, marked not
// indexed; an ingested book whose file moved still appears, marked by its
// true ingestion status. Nothing is invented and nothing is hidden.
export async function listLibrary() {
  const listing = await libraryListing();
  let sources = [];
  let dbError = null;
  try {
    sources = await listSources();
  } catch (err) {
    // No DB does not mean no library: report the files with an honest error.
    dbError = String(err?.code || err?.message || err).slice(0, 80);
  }

  const byKey = new Map(
    sources.map((s) => [`${s.storage_backend}:${s.storage_key}`, s])
  );
  const claimed = new Set();

  const items = [];
  for (const file of listing.files) {
    const exact = byKey.get(`${listing.backend}:${file.key}`);
    let source = null;
    if (exact) {
      source = exact;
    } else {
      // Same byte size and same content hash => the same PDF under a new key.
      const sizeMatches = sources.filter(
        (s) => s.sha256 && s.byte_size != null && String(s.byte_size) === String(file.size ?? '') && !claimed.has(s.source_id)
      );
      if (sizeMatches.length === 1) {
        try {
          const sha = await fileSha256(listing.backend, file.key, file.size, file.lastModified);
          if (sha && sha === sizeMatches[0].sha256) source = sizeMatches[0];
        } catch {
          // Unreadable object: it stays visible as an unindexed file.
        }
      }
    }
    if (source) claimed.add(source.source_id);
    items.push(libraryItem({ file, source, listing, inLibrary: true }));
  }

  // Never drop a book from the selector just because its file is outside the
  // library prefix (an older ingest may point anywhere).
  for (const s of sources) {
    if (!claimed.has(s.source_id)) items.push(libraryItem({ file: syntheticFile(s), source: s, listing, inLibrary: false }));
  }

  items.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  return {
    storage: {
      backend: listing.backend,
      bucket: listing.bucket,
      prefix: listing.prefix,
      listingError: listing.error,
    },
    databaseError: dbError,
    files: listing.files.length,
    items,
  };
}

function syntheticFile(s) {
  const key = String(s.storage_key);
  return {
    key,
    name: key.split('/').pop() || 'source.pdf',
    size: s.byte_size == null ? null : Number(s.byte_size),
    lastModified: s.updated_at,
  };
}

function libraryItem({ file, source, listing, inLibrary }) {
  if (!source) {
    return {
      key: `${listing.backend}:${file.key}`,
      title: (file.name || '').replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim() || 'Untitled PDF',
      author: null,
      indexed: false,
      ingestionStatus: null,
      bookId: null,
      editionId: null,
      editionLabel: null,
      pageCount: null,
      chunkCount: null,
      embeddingDim: null,
      file: {
        backend: listing.backend,
        key: file.key,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        inLibrary,
      },
    };
  }
  return {
    key: `${source.storage_backend}:${source.storage_key}`,
    title: source.title,
    author: source.author,
    // `indexed` is the honest gate: only a COMPLETED source can be asked about.
    indexed: source.ingestion_status === 'COMPLETED',
    ingestionStatus: source.ingestion_status,
    bookId: source.book_id,
    editionId: source.edition_id,
    editionLabel: source.edition_label,
    pageCount: source.page_count == null ? null : Number(source.page_count),
    chunkCount: Number(source.chunk_count),
    embeddingDim: source.embedding_dim == null ? null : Number(source.embedding_dim),
    file: {
      backend: source.storage_backend,
      key: source.storage_key,
      name: file.name,
      size: file.size ?? (source.byte_size == null ? null : Number(source.byte_size)),
      lastModified: file.lastModified,
      inLibrary,
    },
  };
}
