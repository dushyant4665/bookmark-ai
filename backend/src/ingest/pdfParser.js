import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

// ---- Signature + hash (no extension trust) --------------------------------

// Reads just the file header and confirms the real %PDF- magic bytes.
export async function validatePdfSignature(absPath) {
  const head = await readHead(absPath, 1024);
  // A valid PDF begins with "%PDF-1.x" within the first bytes.
  if (!head.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
    throw new Error('NOT_A_PDF');
  }
  const marker = head.indexOf(Buffer.from('%PDF-'));
  if (marker > 1023) throw new Error('NOT_A_PDF');
  return { magic: head.subarray(marker, marker + 8).toString('latin1') };
}

async function readHead(absPath, n) {
  return new Promise((res, rej) => {
    const chunks = [];
    let len = 0;
    const s = createReadStream(absPath, { start: 0, end: n - 1 });
    s.on('data', (c) => {
      chunks.push(c);
      len += c.length;
      if (len >= n) s.destroy();
    });
    s.on('close', () => res(Buffer.concat(chunks).subarray(0, n)));
    s.on('error', (err) => (err.code === 'ENOENT' ? rej(new Error('FILE_NOT_FOUND')) : rej(err)));
  });
}

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const s = createReadStream(absPath);
    s.on('error', reject);
    s.on('data', (c) => hash.update(c));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---- Text normalization (deterministic) -----------------------------------

export function normalizeText(raw) {
  if (raw == null) return '';
  return (
    String(raw)
      // join words hyphenated across a line break: "exam-\nple" -> "example"
      .replace(/(\w)-\n(\w)/g, '$1$2')
      // strip soft hyphens
      .replace(/­/g, '')
      // normalise CRLF/CR -> LF
      .replace(/\r\n?/g, '\n')
      // collapse horizontal runs of spaces (keep newlines as paragraph hints)
      .replace(/[ \t]{2,}/g, ' ')
      // trim trailing spaces per line
      .replace(/[ \t]+$/gm, '')
      // collapse >2 blank lines
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

// Assemble readable raw text from ordered pdfjs text items.
export function buildRawTextFromItems(items) {
  let out = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    out += it.str;
    if (it.hasEOL) out += '\n';
  }
  return out;
}

// Convert pdfjs items into a compact, coordinate-honest structure.
// Coordinates are REAL when the item exposes a transform; otherwise null.
//
// Each retained item also records its [charStart,charEnd) offset within the
// page raw text (see buildRawTextFromItems). Offsets are accumulated over the
// FULL item list — including whitespace-only runs and their EOL newlines — so
// they line up exactly with rawText. Chunk spans (which index rawText) can then
// be mapped to the precise text items for highlighting without guessing.
export function itemsToCoordinates(items) {
  let anyCoords = false;
  let pos = 0;
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    if (typeof it.str !== 'string') continue;
    const charStart = pos;
    pos += it.str.length;
    if (it.hasEOL) pos += 1; // matches buildRawTextFromItems newline
    if (it.str.trim().length === 0) continue; // drop blank items, keep offset accounting
    const t = Array.isArray(it.transform) ? it.transform : null;
    if (t && t.length >= 6) anyCoords = true;
    out.push({
      str: it.str,
      // x/y from the transform translation components (PDF user space).
      x: t ? t[4] : null,
      y: t ? t[5] : null,
      width: Number.isFinite(it.width) ? it.width : null,
      height: Number.isFinite(it.height) ? it.height : null,
      transform: t || null,
      fontName: it.fontName ?? null,
      charStart,
      charEnd: charStart + it.str.length,
    });
  }
  return { items: out, coordinatesAvailable: anyCoords };
}

// ---- Real page extraction -------------------------------------------------

// Lazily import pdfjs so unit tests of the pure helpers never load it.
async function loadPdfJs() {
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return mod;
}

export async function extractPdf(absPath) {
  const { getDocument, VerbosityLevel } = await loadPdfJs();
  const data = await readFileBuffer(absPath);
  let doc;
  try {
    doc = await getDocument({ data, verbosity: VerbosityLevel?.ERRORS ?? 0, isEvalSupported: false }).promise;
  } catch (err) {
    throw new Error(`PDF_PARSE_ERROR:${err?.message || 'unknown'}`);
  }

  const info = await doc.getMetadata().catch(() => null);
  const metadata = info?.info
    ? {
        title: info.info.Title || null,
        author: info.info.Author || null,
        producer: info.info.Producer || null,
        creator: info.info.Creator || null,
      }
    : {};

  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const rawText = buildRawTextFromItems(content.items);
    const { items, coordinatesAvailable } = itemsToCoordinates(content.items);
    pages.push({
      pageNumber: n, // 1-based, matches the actual PDF page index
      width: viewport.width,
      height: viewport.height,
      rotation: page.rotate ?? 0,
      rawText,
      normalizedText: normalizeText(rawText),
      items,
      coordinatesAvailable,
    });
    page.cleanup?.();
  }

  await doc.destroy?.().catch(() => {});
  return { pageCount: doc.numPages, metadata, pages };
}

async function readFileBuffer(absPath) {
  const chunks = [];
  for await (const c of createReadStream(absPath)) chunks.push(c);
  return new Uint8Array(Buffer.concat(chunks));
}
