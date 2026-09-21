import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validatePdfSignature,
  sha256File,
  normalizeText,
  buildRawTextFromItems,
  itemsToCoordinates,
} from '../src/ingest/pdfParser.js';
import { approxTokens, splitSentences, splitParagraphs, chunkPage, buildChunks } from '../src/ingest/chunker.js';
import { chunkUid } from '../src/ingest/ids.js';
import {
  validateVectors,
  normalizeResponse,
  probeDimension,
  embedInBatches,
  withBoundedRetry,
  EmbeddingError,
} from '../src/ingest/embeddingProvider.js';
import { toVectorLiteral } from '../src/ingest/ingestStore.js';

const tmp = (name, data) => {
  const p = join(tmpdir(), `bm-${name}`);
  writeFileSync(p, data);
  return p;
};

test('PDF signature rejects non-PDF and accepts real magic bytes', async () => {
  const bad = tmp('bad.pdf', 'this is not a pdf');
  await assert.rejects(() => validatePdfSignature(bad), /NOT_A_PDF/);
  const good = tmp('good.pdf', '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n...');
  const r = await validatePdfSignature(good);
  assert.match(r.magic, /^%PDF-1\.7/);
  rmSync(bad);
  rmSync(good);
});

test('sha256File is the real content hash (known value)', async () => {
  const p = tmp('hash.txt', 'abc');
  assert.equal(await sha256File(p), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  rmSync(p);
});

test('normalizeText joins hyphenated line breaks and collapses whitespace', () => {
  assert.equal(normalizeText('exam-\nple   one\r\ntwo'), 'example one\ntwo');
});

test('buildRawTextFromItems honours EOL flags', () => {
  const text = buildRawTextFromItems([
    { str: 'Hello', hasEOL: false },
    { str: ' world', hasEOL: true },
    { str: 'Second line', hasEOL: true },
  ]);
  assert.equal(text, 'Hello world\nSecond line\n');
});

test('itemsToCoordinates keeps REAL coords and marks unavailable as null', () => {
  const { items, coordinatesAvailable } = itemsToCoordinates([
    { str: 'Word', transform: [10, 0, 0, 12, 72, 700], width: 30, height: 12 },
    { str: '   ', transform: [1, 0, 0, 1, 0, 0] },
  ]);
  assert.equal(coordinatesAvailable, true);
  assert.equal(items[0].x, 72);
  assert.equal(items[0].y, 700);
  assert.equal(items[0].width, 30);
  // whitespace-only item is dropped, not given fake geometry
  assert.equal(items.length, 1);
});

test('itemsToCoordinates reports unavailable when no transform exists', () => {
  const { items, coordinatesAvailable } = itemsToCoordinates([{ str: 'NoGeom' }]);
  assert.equal(coordinatesAvailable, false);
  assert.equal(items[0].x, null);
  assert.equal(items[0].transform, null);
});

test('approxTokens + splitSentences are deterministic and sentence-safe', () => {
  assert.equal(approxTokens('one two  three'), 3);
  const s = splitSentences('Dr. Smith went home. It was late!');
  assert.equal(s[0].text, 'Dr. Smith went home.'); // not split on "Dr."
  assert.equal(s.length, 2);
  // offsets slice back to the exact original substrings
  const text = 'Alpha beta. Gamma delta.';
  const parts = splitSentences(text);
  assert.equal(parts.map((p) => text.slice(p.start, p.end)).join(' '), text);
});

test('splitParagraphs respects blank-line boundaries with offsets', () => {
  const text = 'Para one line A\nline B\n\nPara two';
  const paras = splitParagraphs(text);
  assert.equal(paras.length, 2);
  assert.equal(paras[0].text.startsWith('Para one line A'), true);
  assert.equal(paras[1].text, 'Para two');
});

test('chunkPage: empty page yields no chunks', () => {
  const chunks = chunkPage({ pageNumber: 1, rawText: '   \n  ', coordinatesAvailable: false });
  assert.equal(chunks.length, 0);
});

test('buildChunks is deterministic for identical input', () => {
  const pages = makePages(6, 40);
  const a = buildChunks(pages, cfg());
  const b = buildChunks(pages, cfg());
  assert.deepEqual(
    a.map((c) => [c.sourceText, c.pageStart, c.spans]),
    b.map((c) => [c.sourceText, c.pageStart, c.spans])
  );
});

test('chunks never cross pages and carry provenance spans + null chapter', () => {
  const chunks = buildChunks(makePages(4, 60), cfg());
  for (const c of chunks) {
    assert.equal(c.pageStart, c.pageEnd);
    assert.equal(c.chapter, null); // never invented
    assert.ok(c.spans.length >= 1);
    for (const s of c.spans) assert.equal(s.pageNumber, c.pageStart);
    assert.ok(c.tokenCount > 0);
  }
});

test('chunking respects the target token budget', () => {
  const cfgv = cfg();
  const chunks = buildChunks(makePages(3, 300), cfgv); // 300 words per page
  for (const c of chunks) {
    // allow headroom of one sentence over target, but capped by max + overlap
    assert.ok(c.tokenCount <= cfgv.chunkMaxTokens + 40, `chunk too big: ${c.tokenCount}`);
  }
  assert.ok(chunks.length >= 3, 'long pages should split into multiple chunks');
});

test('adjacent chunks overlap (a repeated tail sentence appears in both)', () => {
  const cfgv = { ...cfg(), chunkOverlapTokens: 12 };
  const chunks = buildChunks(makePages(1, 120), cfgv);
  assert.ok(chunks.length >= 2, 'expected multiple chunks to test overlap');
  const firstTokens = new Set(chunks[0].sourceText.split(/\s+/));
  const secondTokens = new Set(chunks[1].sourceText.split(/\s+/));
  let shared = 0;
  for (const t of secondTokens) if (firstTokens.has(t)) shared++;
  assert.ok(shared > 0, 'expected overlap between consecutive chunks');
});

test('chunkUid is deterministic and sensitive to version + text', () => {
  const base = { sourceId: 's1', chunkerVersion: 'v1', chunkIndex: 0, pageNumber: 3, sourceText: 'hello' };
  assert.equal(chunkUid(base), chunkUid({ ...base }));
  assert.notEqual(chunkUid(base), chunkUid({ ...base, sourceText: 'hello world' }));
  assert.notEqual(chunkUid(base), chunkUid({ ...base, chunkerVersion: 'v2' }));
});

test('validateVectors enforces numeric, consistent dim, no NaN/Infinity', () => {
  assert.equal(validateVectors([[1, 2, 3]], 3), 3);
  assert.throws(() => validateVectors([[1, 2], [1, 2, 3]]), EmbeddingError);
  assert.throws(() => validateVectors([[1, NaN, 3]]), /EMBEDDING_NAN/);
  assert.throws(() => validateVectors([[1, Infinity, 3]]), /EMBEDDING_INFINITY/);
  assert.throws(() => validateVectors([[1, 2, 3]], 768), /EMBEDDING_DIM_MISMATCH/);
  assert.throws(() => validateVectors([]), /EMBEDDING_EMPTY/);
});

test('normalizeResponse accepts single + batched HF shapes', () => {
  assert.deepEqual(normalizeResponse([[1, 2]], 1), [[1, 2]]);
  assert.deepEqual(normalizeResponse([1, 2, 3], 1), [[1, 2, 3]]);
  assert.equal(normalizeResponse([[1], [2]], 2).length, 2);
});

test('probeDimension reports the ACTUAL vector length from the provider', async () => {
  const dim = await probeDimension(mockProvider([0.1, 0.2, 0.3]));
  assert.equal(dim, 3);
});

test('embedInBatches chunks requests and validates every vector', async () => {
  const texts = ['a', 'b', 'c', 'd', 'e'];
  const calls = [];
  const provider = {
    modelId: () => 'mock',
    embedBatch: async (batch) => {
      calls.push(batch.length);
      return batch.map(() => [1, 2, 3]);
    },
  };
  const vectors = await embedInBatches(provider, texts, { expectedDim: 3, batchSize: 2 });
  assert.equal(vectors.length, 5);
  assert.deepEqual(calls, [2, 2, 1]);
});

test('withBoundedRetry retries transient failures then succeeds, bounded', async () => {
  let n = 0;
  const ok = await withBoundedRetry(async () => {
    n++;
    if (n < 3) throw new EmbeddingError('EMBEDDING_HTTP_503', true);
    return 'done';
  }, 5, 1);
  assert.equal(ok, 'done');
  assert.equal(n, 3);

  let m = 0;
  await assert.rejects(
    withBoundedRetry(async () => {
      m++;
      throw new EmbeddingError('EMBEDDING_HTTP_500', true);
    }, 2, 1),
    /EMBEDDING_HTTP_500/
  );
  assert.equal(m, 3); // 1 try + 2 retries
});

test('non-retryable errors are not retried', async () => {
  let m = 0;
  await assert.rejects(
    withBoundedRetry(async () => {
      m++;
      throw new EmbeddingError('EMBEDDING_HTTP_400', false);
    }, 4, 1),
    /EMBEDDING_HTTP_400/
  );
  assert.equal(m, 1);
});

test('toVectorLiteral produces a pgvector literal and rejects NaN', () => {
  assert.equal(toVectorLiteral([1, 2.5, 3]), '[1,2.5,3]');
  assert.throws(() => toVectorLiteral([1, NaN, 3]), /EMBEDDING_NAN/);
});

// ---- helpers -------------------------------------------------------------

function cfg() {
  return { chunkTargetTokens: 50, chunkMaxTokens: 80, chunkOverlapTokens: 6, minChunkTokens: 5 };
}

function makePages(count, wordsPerPage) {
  const pages = [];
  for (let p = 1; p <= count; p++) {
    let text = '';
    for (let w = 0; w < wordsPerPage; w++) {
      text += `page${p}word${w} `;
      if ((w + 1) % 8 === 0) text += (w + 1) % 16 === 0 ? '.\n\n' : '. ';
    }
    text += '.';
    pages.push({
      pageNumber: p,
      rawText: text,
      normalizedText: normalizeText(text),
      coordinatesAvailable: p % 2 === 0,
    });
  }
  return pages;
}

function mockProvider(vector) {
  return { modelId: () => 'mock', embedBatch: async () => [vector] };
}
