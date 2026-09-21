import { env } from '../config/env.js';

// Minimal in-memory sliding-window rate limiter (§18). No Redis on purpose —
// this is a single-instance safeguard. IMPORTANT: on Render with MULTIPLE
// instances (or autoscaling) each process keeps its own counters, so the limit
// is per-instance; a shared store would be required for a global guarantee.
// The spec explicitly says not to introduce Redis unless necessary — it isn't
// yet for this deployment shape, so we document the tradeoff instead.

export function rateLimit({ windowMs = 60_000, max = 20, keyPrefix = 'g' } = {}) {
  const hits = new Map(); // key -> number[] (request timestamps)

  // Opportunistic cleanup so the map can't grow unbounded across many keys.
  let lastSweep = Date.now();
  const sweep = (now) => {
    if (now - lastSweep < windowMs) return;
    lastSweep = now;
    for (const [k, arr] of hits) {
      const live = arr.filter((t) => now - t < windowMs);
      if (live.length) hits.set(k, live);
      else hits.delete(k);
    }
  };

  return function middleware(req, res, next) {
    // Trust the authenticated id when present, else the socket address.
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${req.userId || ip}`;
    const now = Date.now();
    sweep(now);

    const arr = hits.get(key) || [];
    const live = arr.filter((t) => now - t < windowMs);
    if (live.length >= max) {
      hits.set(key, live);
      res.setHeader('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    live.push(now);
    hits.set(key, live);
    next();
  };
}

// Configurable, conservative defaults. Disabled only if explicitly turned off.
const enabled = process.env.RATE_LIMIT !== 'false';
const factor = Number(process.env.RATE_LIMIT_FACTOR || 1);

function limit(n) {
  return enabled ? Math.max(1, Math.round(n * factor)) : Number.MAX_SAFE_INTEGER;
}

export const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: limit(20), keyPrefix: 'auth' });
export const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: limit(10), keyPrefix: 'login' });
// Chat is token-costly; keep it modest per user.
export const chatLimiter = rateLimit({ windowMs: 60_000, max: limit(10), keyPrefix: 'chat' });

// Guard against misconfig in production: warn (never print secrets) at startup.
if (env.isProd && !enabled) {
  console.warn('[security] rate limiting is DISABLED in production (RATE_LIMIT=false)');
}
