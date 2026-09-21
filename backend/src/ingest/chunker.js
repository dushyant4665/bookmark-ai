import { ingestConfig } from './config.js';

// Deterministic, document-aware chunker.
//
// Design notes / tradeoffs (documented per Phase 2 §9):
//  - No external tokenizer is bundled, so tokens are approximated by a
//    deterministic count of non-whitespace runs (`approxTokens`). It is stable
//    across runs and across machines, which is what chunking + retries need.
//  - We chunk per physical PDF page. A chunk therefore never crosses a page
//    boundary, which keeps provenance unambiguous for Phase 4 highlighting
//    (page_start == page_end). The schema still carries both columns.
//  - Sentences are split on real terminators so we never cut mid-sentence;
//    a sentence longer than the hard max is split on word boundaries.
//  - `chapter` is intentionally left null unless the caller supplies a
//    confidently detected section — we never invent titles (Phase 2 §8).

export function approxTokens(text) {
  if (!text) return 0;
  const m = String(text).match(/\S+/g);
  return m ? m.length : 0;
}

// Common abbreviations (lowercased) that end in "." but don't end a sentence.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'st', 'jr', 'sr', 'prof', 'rev', 'hon',
  'inc', 'ltd', 'co', 'corp', 'vs', 'etc', 'fig', 'pp', 'vol',
  'no', 'dept', 'univ', 'approx', 'misc',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
]);

// True when the token ending just before a "." looks like an abbreviation or a
// single-letter initial, so we don't split a sentence there.
function isAbbreviation(prefix) {
  const m = prefix.match(/([A-Za-z.]+)$/);
  if (!m) return false;
  const raw = m[1];
  const tok = raw.replace(/\.$/, '').toLowerCase();
  if (ABBREVIATIONS.has(tok) || ABBREVIATIONS.has(raw.toLowerCase())) return true;
  if (/^[a-z]$/.test(tok)) return true; // e.g. "J."
  return false;
}

// Split text into sentence units with exact [start,end) offsets into `text`.
export function splitSentences(text) {
  const units = [];
  const n = text.length;
  let i = 0;
  let start = 0;
  const quoteClose = new Set(['"', "'", ')', ']', '’', '”']);

  const trim = (s, base) => {
    let a = 0;
    let b = s.length;
    while (a < b && /\s/.test(s[a])) a++;
    while (b > a && /\s/.test(s[b - 1])) b--;
    return { text: s.slice(a, b), start: base + a, end: base + b };
  };

  while (i < n) {
    const ch = text[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      let j = i + 1;
      while (j < n && quoteClose.has(text[j])) j++;
      // Guard against splitting on abbreviations ("Dr.", "e.g.") and initials ("J.").
      if (ch === '.' && isAbbreviation(text.slice(start, i))) {
        i = j;
        continue;
      }
      if (j < n && /\s/.test(text[j])) {
        let k = j;
        while (k < n && /\s/.test(text[k])) k++;
        const next = text[k];
        // Only end a sentence when a new one plausibly begins.
        if (next && (/\p{Lu}/u.test(next) || /\d/.test(next) || quoteClose.has(next))) {
          const u = trim(text.slice(start, j), start);
          if (u.text) units.push(u);
          start = j;
          i = j;
          continue;
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < n) {
    const u = trim(text.slice(start), start);
    if (u.text) units.push(u);
  }
  return units;
}

// Split raw text into paragraphs on blank lines, tracking offsets into `text`.
export function splitParagraphs(text) {
  const paras = [];
  const re = /\n\s*\n+/g;
  let from = 0;
  let m;
  while ((m = re.exec(text))) {
    push(trimSlice(text, from, m.index));
    from = m.index + m[0].length;
  }
  push(trimSlice(text, from, text.length));
  return paras;

  function push(p) {
    if (p && p.text) paras.push(p);
  }
}

function trimSlice(text, a, b) {
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return { text: text.slice(a, b), start: a, end: b };
}

// Force-split an over-long sentence into word chunks no bigger than maxTokens.
function splitLongSentence(text, start, maxTokens) {
  const words = [];
  const re = /\S+\s*/g;
  let m;
  while ((m = re.exec(text))) words.push({ s: m[0], start: start + m.index, len: m[0].length });
  const pieces = [];
  let bucket = [];
  let bucketChars = 0;
  let bucketStart = null;
  const flush = () => {
    if (!bucket.length) return;
    const joined = bucket.join('').replace(/\s+$/g, '');
    pieces.push({ text: joined, start: bucketStart, end: bucketStart + joined.length });
    bucket = [];
    bucketChars = 0;
    bucketStart = null;
  };
  for (const w of words) {
    if (bucketStart === null) bucketStart = w.start;
    bucket.push(w.s);
    bucketChars += approxTokens(w.s);
    if (bucketChars >= maxTokens) flush();
  }
  flush();
  return pieces;
}

// Turn one page's raw text into ordered sentence units (with page provenance).
function pageSentenceUnits(page, maxTokens) {
  const raw = page.rawText ?? '';
  const units = [];
  for (const para of splitParagraphs(raw)) {
    for (const s of splitSentences(para.text)) {
      // Re-base offsets from the paragraph slice to the full page text.
      const abs = { text: s.text, start: para.start + s.start, end: para.start + s.end };
      if (approxTokens(abs.text) > maxTokens) {
        for (const p of splitLongSentence(abs.text, abs.start, maxTokens)) {
          units.push({ ...p, pageNumber: page.pageNumber, tokens: approxTokens(p.text) });
        }
      } else if (abs.text) {
        units.push({ ...abs, pageNumber: page.pageNumber, tokens: approxTokens(abs.text) });
      }
    }
  }
  return units;
}

// Build chunks for a single page's sentence stream using a target/max budget + overlap.
export function chunkPage(page, cfg = ingestConfig) {
  const { chunkTargetTokens, chunkMaxTokens, chunkOverlapTokens, minChunkTokens } = cfg;
  const units = pageSentenceUnits(page, chunkMaxTokens);
  const out = [];
  if (!units.length) return out;

  let cur = [];
  let curTokens = 0;

  const emit = (list) => {
    if (!list.length) return;
    const sourceText = list.map((u) => u.text).join(' ');
    out.push({
      pageNumber: page.pageNumber,
      sourceText,
      tokenCount: list.reduce((s, u) => s + u.tokens, 0),
      charCount: sourceText.length,
      spans: list.map((u) => ({ pageNumber: page.pageNumber, charStart: u.start, charEnd: u.end })),
      coordinatesAvailable: Boolean(page.coordinatesAvailable),
    });
  };

  const takeOverlap = (list) => {
    const tail = [];
    let t = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (t + list[i].tokens > chunkOverlapTokens) break;
      tail.unshift(list[i]);
      t += list[i].tokens;
    }
    return tail;
  };

  for (const u of units) {
    if (cur.length > 0 && curTokens + u.tokens > chunkTargetTokens) {
      const done = cur;
      emit(done);
      cur = takeOverlap(done);
      curTokens = cur.reduce((s, x) => s + x.tokens, 0);
    }
    cur.push(u);
    curTokens += u.tokens;
  }
  emit(cur);

  // Merge trailing fragments that are too small into the previous chunk.
  if (out.length >= 2 && out[out.length - 1].tokenCount < minChunkTokens) {
    const last = out.pop();
    const prev = out[out.length - 1];
    prev.sourceText += ' ' + last.sourceText;
    prev.tokenCount += last.tokenCount;
    prev.charCount += last.charCount;
    prev.spans.push(...last.spans);
  }
  return out;
}

// Full page list -> deterministic chunk list with stable chunk_index ordering.
export function buildChunks(pages, cfg = ingestConfig) {
  const chunks = [];
  let index = 0;
  for (const page of pages) {
    for (const c of chunkPage(page, cfg)) {
      chunks.push({
        chunkIndex: index++,
        pageNumber: c.pageNumber,
        pageStart: c.pageNumber,
        pageEnd: c.pageNumber,
        chapter: null, // never invented
        sourceText: c.sourceText,
        searchText: normalizeForSearch(c.sourceText),
        spans: c.spans,
        coordinatesAvailable: c.coordinatesAvailable,
        tokenCount: c.tokenCount,
        charCount: c.charCount,
      });
    }
  }
  return chunks;
}

// search_text = normalized text used for embeddings + full-text search.
// The authoritative original stays in source_text; we never overwrite it.
function normalizeForSearch(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
