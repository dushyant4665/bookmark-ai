import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { env } from '../src/config/env.js';
import { makeStorageProvider, relocateMissingSource } from '../src/services/storageService.js';

const sha = (s) => createHash('sha256').update(s).digest('hex');

// Files move: the bucket gets reorganised from the dashboard, a dev-only local
// path never reaches production. A stale key must be repaired by CONTENT only —
// picking the wrong PDF would silently break every citation.
test('a missing source is relocated only by a byte-for-byte sha256 match', async () => {
  const candidates = [
    { storageBackend: 'supabase', storageKey: 'books/wrong.pdf', byteSize: 999 },
    { storageBackend: 'supabase', storageKey: 'books/right.pdf', byteSize: 10 },
  ];
  const hashed = [];
  const hashOf = async (backend, key) => {
    hashed.push(`${backend}:${key}`);
    return key.endsWith('right.pdf') ? sha('the bytes') : sha('other');
  };

  const found = await relocateMissingSource(
    { storage_backend: 'local', storage_key: 'gone/source.pdf', sha256: sha('the bytes'), byte_size: 10 },
    { candidates: async () => candidates, hashOf }
  );

  assert.deepEqual(found, candidates[1]);
  // The size filter means only the plausible candidate was ever downloaded.
  assert.deepEqual(hashed, ['supabase:books/right.pdf']);
});

test('an unreadable candidate never aborts the search', async () => {
  const found = await relocateMissingSource(
    { storage_backend: 'local', storage_key: 'gone/source.pdf', sha256: sha('second'), byte_size: null },
    {
      candidates: async () => [
        { storageBackend: 'supabase', storageKey: 'books/broken.pdf' },
        { storageBackend: 'supabase', storageKey: 'books/ok.pdf' },
      ],
      hashOf: async (backend, key) => {
        if (key.includes('broken')) throw new Error('STORAGE_UPSTREAM_500');
        return sha('second');
      },
    }
  );
  assert.equal(found.storageKey, 'books/ok.pdf');
});

test('no match returns null instead of guessing from the filename', async () => {
  const found = await relocateMissingSource(
    { storage_backend: 'local', storage_key: 'gone/source.pdf', sha256: sha('known'), byte_size: null },
    {
      candidates: async () => [{ storageBackend: 'supabase', storageKey: 'books/source.pdf' }],
      hashOf: async () => sha('a different book entirely'),
    }
  );
  assert.equal(found, null);
});

test('a source with no recorded hash is left alone (nothing to verify against)', async () => {
  let hashed = 0;
  const found = await relocateMissingSource(
    { storage_backend: 'local', storage_key: 'gone/source.pdf', sha256: null },
    {
      candidates: async () => [{ storageBackend: 'supabase', storageKey: 'books/source.pdf' }],
      hashOf: async () => {
        hashed++;
        return sha('x');
      },
    }
  );
  assert.equal(found, null);
  assert.equal(hashed, 0);
});

test('the local provider lists every PDF under the managed dir as relative keys', async () => {
  const dir = join(tmpdir(), 'bm-library-list');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'zero-to-one', 'default'), { recursive: true });
  writeFileSync(join(dir, 'notes.txt'), 'not a book');
  writeFileSync(join(dir, 'zero-to-one', 'default', 'source.pdf'), '%PDF-1.7');

  const saved = env.storageLocalDir;
  env.storageLocalDir = dir;
  try {
    const files = await makeStorageProvider('local').list();
    assert.deepEqual(files.map((f) => f.key), ['zero-to-one/default/source.pdf']);
    assert.equal(files[0].name, 'source.pdf');
    assert.equal(files[0].size, Buffer.byteLength('%PDF-1.7'));
  } finally {
    env.storageLocalDir = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// PDF.js asks for one byte range per read. If a provider cannot report its size
// the route silently re-sends the whole book on every single request.
test('a local byte-range request returns just that slice', async () => {
  const dir = join(tmpdir(), 'bm-range-list');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'book.pdf'), '0123456789ABCDE');
  const saved = env.storageLocalDir;
  env.storageLocalDir = dir;
  try {
    const provider = makeStorageProvider('local');
    assert.equal((await provider.info('book.pdf')).byteSize, 15);
    const opened = await provider.open('book.pdf', { range: { start: 4, end: 8 } });
    assert.equal(opened.status, 206);
    assert.equal(opened.contentRange, 'bytes 4-8/15');
    let body = '';
    for await (const c of opened.stream) body += c;
    assert.equal(body, '45678');
  } finally {
    env.storageLocalDir = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
