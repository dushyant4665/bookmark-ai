// Canonical internal evidence model (Phase 3 §13).
//
// HARD RULE: every field here originates from PostgreSQL. The model never
// supplies page numbers, spans or coordinates — retrieval does. Retrieval
// modules return "candidate" rows; the service promotes final candidates to
// Evidence with a short, opaque evidenceId token that is safe to hand to Groq.

export const SELECT_COLUMNS = `
  c.id,
  c.book_id,
  c.edition_id,
  c.book_source_id,
  c.page_id,
  c.chunk_uid,
  c.page_start,
  c.page_end,
  c.chapter,
  c.source_text,
  c.search_text,
  c.spans,
  c.coordinates_available`;

// DB row -> candidate (shared by vector + lexical so both fuse cleanly).
export function rowToCandidate(row) {
  return {
    chunkId: row.id,
    chunkUid: row.chunk_uid,
    bookId: row.book_id,
    editionId: row.edition_id,
    sourceId: row.book_source_id,
    pageId: row.page_id,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    section: row.chapter ?? null,
    text: row.source_text,
    searchText: row.search_text,
    spans: row.spans ?? [],
    coordinatesAvailable: Boolean(row.coordinates_available),
  };
}

// Candidate + model-facing token -> Evidence. `evidenceId` is the ONLY id the
// model ever sees; the backend resolves it back to the real DB row.
export function toEvidence(candidate, evidenceId) {
  return {
    evidenceId, // e.g. "e1" — opaque, membership-checked
    chunkId: candidate.chunkId,
    bookId: candidate.bookId,
    editionId: candidate.editionId,
    sourceId: candidate.sourceId,
    pageId: candidate.pageId,
    pageStart: candidate.pageStart,
    pageEnd: candidate.pageEnd,
    section: candidate.section,
    text: candidate.text,
    coordinatesAvailable: candidate.coordinatesAvailable,
    provenance: {
      spans: candidate.spans,
      coordinatesAvailable: candidate.coordinatesAvailable,
    },
    retrieval: candidate.retrieval ?? {},
    rerank: candidate.rerank ?? null,
  };
}

// The citation payload the backend returns to the client. Page/text/source all
// come from the database, never from generated text (§19).
export function toCitation(evidence) {
  return {
    evidenceId: evidence.evidenceId,
    chunkId: evidence.chunkId,
    sourceId: evidence.sourceId,
    pageId: evidence.pageId,
    bookId: evidence.bookId,
    editionId: evidence.editionId,
    page: evidence.pageStart,
    pageStart: evidence.pageStart,
    pageEnd: evidence.pageEnd,
    chapter: evidence.section,
    text: evidence.text,
    coordinatesAvailable: evidence.coordinatesAvailable,
    spans: evidence.provenance.spans,
    // Real PDF user-space rects from the page's text items (Phase 4). Empty when
    // coordinates are unavailable — the client then shows an honest fallback.
    rects: evidence.rects ?? [],
  };
}
