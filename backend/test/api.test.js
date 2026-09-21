import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// Boots the real Express app on an ephemeral port. No database is required —
// these cover auth gating and honest transport behaviour, not data reads.
process.env.JWT_SECRET ||= 'test-secret-not-for-production';
process.env.NODE_ENV = 'test';

const { createApp } = await import('../src/app.js');

let server;
let base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});

after(() => server.close());

test('GET /api/health is public and honest about every dependency', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  // status reflects real config: 'ok' only when all critical deps are present.
  assert.ok(['ok', 'degraded'].includes(body.status));
  assert.ok(['connected', 'not_configured', 'error'].includes(body.database));
  assert.ok(['configured', 'not_configured'].includes(body.storage));
  assert.ok(['configured', 'not_configured'].includes(body.embedding));
  assert.ok(['configured', 'not_configured'].includes(body.groq));
  // Never leaks secrets in the health payload.
  const raw = JSON.stringify(body);
  assert.ok(!/postgres:\/\//i.test(raw) && !/eyJ/i.test(raw));
});

test('book routes require authentication', async () => {
  const res = await fetch(`${base}/books`);
  assert.equal(res.status, 401);
});

test('chat stream rejects unauthenticated requests', async () => {
  const res = await fetch(`${base}/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookId: 'b', editionId: 'e', message: 'hi' }),
  });
  assert.equal(res.status, 401);
});

test('unknown routes return a clean JSON 404 (no stack trace)', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: 'NOT_FOUND' });
});
