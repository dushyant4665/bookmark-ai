import { env } from '../config/env.js';
import { getPool, dbAvailable } from '../db/pool.js';
import { groqConfigured } from './groqService.js';
import { embeddingProviderInfo } from '../ingest/embeddingProvider.js';

// Production health snapshot (§31). Reports the ACTUAL state of each dependency
// and never inflates: "configured" means the required env vars are present; it
// does NOT assert the remote service is reachable. A live provider probe (e.g.
// embeddings) belongs to `npm run verify:production`, not this hot path — so we
// never block health on a slow or blocked upstream.

function flag(ok) {
  // "configured" = required env present. It deliberately does NOT claim the
  // remote service is reachable — that liveness is proven by verify:production,
  // never asserted here on a hot path.
  return ok ? 'configured' : 'not_configured';
}

export async function healthSnapshot() {
  const out = {
    status: 'ok',
    database: 'not_configured',
    storage: flag(Boolean(env.storageBackend)),
    embedding: 'not_configured',
    groq: groqConfigured() ? 'configured' : 'not_configured',
  };

  // Storage readiness is backend-specific: local needs a dir, supabase needs
  // url + service key + bucket. Report configured vs not, values never exposed.
  if (env.storageBackend === 'supabase') {
    out.storage = flag(Boolean(env.supabaseUrl && env.supabaseServiceRoleKey && env.supabaseStorageBucket));
  } else {
    out.storage = flag(Boolean(env.storageLocalDir));
  }

  // Embedding: "configured" means the SELECTED vendor has both key + model.
  // Healthy is unknown here by design (a blocked/unreachable provider must not
  // be masked as ready, and must never slow this endpoint down).
  const embedding = embeddingProviderInfo();
  out.embedding = flag(embedding.configured);
  // §32 honest shape: reachability is NOT probed on this hot path (a blocked
  // provider must never hang or crash health). verify:production does the live
  // probe. We only report what is guaranteed cheaply here.
  out.embeddingProvider = {
    provider: embedding.provider,
    configured: embedding.configured,
    reachable: 'not_probed_on_health_path',
  };
  out.vectorIndex = { configured: false, populated: false };

  // Real, cheap DB liveness check when a pool is configured.
  if (dbAvailable()) {
    const pool = getPool();
    try {
      await pool.query('SELECT 1');
      out.database = 'connected';
    } catch {
      out.database = 'error';
      out.status = 'degraded';
    }
    // Vector index truth (never throws — a missing index is a fact, not a crash).
    if (out.database === 'connected') {
      try {
        const idx = await pool.query(
          `SELECT 1 FROM pg_indexes WHERE tablename='literature_chunks'
             AND indexdef ILIKE '%embedding%' AND indexdef ILIKE '%hnsw%' LIMIT 1`
        );
        const pop = await pool.query(
          `SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded
             FROM literature_chunks`
        );
        const embedded = pop.rows[0]?.embedded ?? 0;
        out.vectorIndex = { configured: idx.rows.length > 0, populated: embedded > 0 };
      } catch {
        /* leave vectorIndex false/false — never fail health on introspection */
      }
    }
  } else {
    out.status = 'degraded';
  }

  return out;
}
