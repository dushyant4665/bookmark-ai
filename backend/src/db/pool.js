import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

let pool = null;

// Sanitize the optional schema name to a safe SQL identifier (defensive; it
// only ever comes from our own env, never from a request).
export function safeSchema() {
  const s = (env.pgSchema || '').trim();
  if (!s) return '';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(s)) {
    throw new Error(`invalid PGSCHEMA "${s}" (use lowercase letters, digits, underscore)`);
  }
  return s;
}

// Connection-level search_path so all unqualified table names resolve inside
// our dedicated schema, falling back to public for the vector extension/types.
export function searchPathOptions() {
  const s = safeSchema();
  return s ? `-c search_path=${s},public` : undefined;
}

// Lazily create a single pool. The server must boot cleanly even when
// DATABASE_URL is unset (no database yet) — DB-backed routes then report
// an honest "database unavailable" instead of crashing.
export function getPool() {
  if (pool) return pool;
  if (!env.databaseUrl) {
    return null;
  }
  pool = new Pool({
    connectionString: env.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl)
      ? false
      : { require: true, rejectUnauthorized: false },
    options: searchPathOptions(),
    max: Number(process.env.PG_POOL_MAX || 10),
    // Never hang a request forever waiting on a cold/blocked connection.
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  });
  pool.on('error', (err) => logger.error('pg pool idle error', err.message));
  return pool;
}

// Close the shared pool on shutdown so Render can recycle cleanly.
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export function dbAvailable() {
  return Boolean(env.databaseUrl);
}

// Throws a typed error the routes can turn into a 503.
export async function query(text, params) {
  const p = getPool();
  if (!p) {
    const e = new Error('DATABASE_UNAVAILABLE');
    e.code = 'DATABASE_UNAVAILABLE';
    throw e;
  }
  return p.query(text, params);
}

// Check out a dedicated client for a transactional unit of work (used by the
// resumable embedding backfill). The client is always released, even on error.
export async function withClient(fn) {
  const p = getPool();
  if (!p) {
    const e = new Error('DATABASE_UNAVAILABLE');
    e.code = 'DATABASE_UNAVAILABLE';
    throw e;
  }
  const client = await p.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
