import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { env } from '../config/env.js';
import { safeSchema } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Applies the Phase 1 schema. Requires DATABASE_URL. Safe to re-run (idempotent DDL).
async function migrate() {
  if (!env.databaseUrl) {
    console.error('[migrate] DATABASE_URL is not set. Refusing to run against an unknown database.');
    process.exit(1);
  }
  const raw = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  const sql = raw.replaceAll('__EMBEDDING_DIM__', String(env.embeddingDim));
  const schema = safeSchema();

  const client = new pg.Client({
    connectionString: env.databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(env.databaseUrl) ? false : { require: true, rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (schema) {
      // Create + target a dedicated schema so we never touch another app's
      // tables in `public`. Identifier is validated by safeSchema().
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(`SET search_path TO ${schema}, public`);
    }
    await client.query(sql);
    await client.query('COMMIT');
    console.log(`[migrate] schema applied${schema ? ` into schema "${schema}"` : ''} (embedding dim = ${env.embeddingDim}).`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[migrate] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

migrate();
