// Phase 4 — highlight geometry (coordinate truth lives in PostgreSQL).
//
// A chunk's `spans` are [charStart,charEnd) offsets into the page's `raw_text`
// (see chunker.js). The page's `text_items` carry the real PDF user-space box of
// each extracted run (see pdfParser.itemsToCoordinates). This module joins the
// two so a citation can be highlighted by exactly the text items the evidence
// came from — never the whole page, never an invented rectangle.
//
// If a page has no usable coordinates, we return [] and the caller renders the
// honest "exact highlight unavailable" fallback. We never guess a box.

// Pure: which text items intersect the chunk's spans? One rect per item, so a
// multi-line / multi-span passage becomes several real rectangles.
export function spansToRects(spans, textItems) {
  if (!Array.isArray(spans) || !spans.length) return [];
  const ranges = [];
  for (const s of spans) {
    const a = Number(s?.charStart);
    const b = Number(s?.charEnd);
    if (Number.isFinite(a) && Number.isFinite(b) && b > a) ranges.push([a, b]);
  }
  if (!ranges.length) return [];
  if (!Array.isArray(textItems)) return [];

  const rects = [];
  for (const it of textItems) {
    const x = Number(it?.x);
    const y = Number(it?.y);
    const width = Number(it?.width);
    const height = Number(it?.height);
    if (![x, y, width, height].every(Number.isFinite)) continue;
    if (width <= 0 || height <= 0) continue;
    const s = Number(it?.charStart);
    const e = Number(it?.charEnd);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue;
    const intersects = ranges.some(([a, b]) => s < b && e > a);
    if (intersects) rects.push({ x, y, width, height });
  }
  return rects;
}

// Attach real highlight rects to resolved evidence rows, in place.
//
// Only pages whose chunk reports coordinates_available are fetched, and each
// fetch is scoped to the chunk's own source so a citation can never reach a
// page belonging to a different edition's PDF. Distinct page ids are read once.
export async function attachRectsToEvidence({ runQuery, evidence = [] }) {
  const cache = new Map();
  for (const ev of evidence) {
    if (!ev?.coordinatesAvailable || !ev?.pageId) {
      ev.rects = [];
      continue;
    }
    const key = `${ev.pageId}:${ev.sourceId ?? ''}`;
    let rects = cache.get(key);
    if (rects === undefined) {
      rects = await loadRectsForEvidence({ runQuery, ev });
      cache.set(key, rects);
    }
    ev.rects = rects;
  }
  return evidence;
}

async function loadRectsForEvidence({ runQuery, ev }) {
  const spans = ev?.provenance?.spans ?? ev?.spans ?? [];
  if (!Array.isArray(spans) || !spans.length) return [];
  const { rows } = await runQuery(
    `SELECT text_items, coordinates_available
       FROM book_pages
      WHERE id = $1 AND book_source_id = $2
      LIMIT 1`,
    [ev.pageId, ev.sourceId]
  );
  const page = rows[0];
  if (!page || !page.coordinates_available) return [];
  return spansToRects(spans, page.text_items ?? []);
}
