import dotenv from 'dotenv';

dotenv.config();

const requiredInProd = ['JWT_SECRET', 'DATABASE_URL'];

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: (process.env.NODE_ENV || 'development') === 'production',
  port: Number(process.env.PORT || 4000),

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  databaseUrl: process.env.DATABASE_URL || '',
  // Optional dedicated Postgres schema so BOOKMARK can share a Supabase project
  // without colliding with another app's `public` tables. Identifier-sanitized
  // at the connection layer. Empty => default search_path.
  pgSchema: process.env.PGSCHEMA || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET || 'book-pdfs',

  hfApiKey: process.env.HUGGINGFACE_API_KEY || '',
  hfEmbeddingModel: process.env.HF_EMBEDDING_MODEL || '',
  jinaApiKey: process.env.JINA_API_KEY || '',
  jinaEmbeddingModel: process.env.JINA_EMBEDDING_MODEL || '',
  // One explicit switch decides which vendor the embedding seam calls. It is
  // deliberately NOT inferred from whichever keys happen to exist — a silent
  // vendor swap would change the vector dimension without anyone choosing it.
  embeddingProvider: (process.env.EMBEDDING_PROVIDER || 'huggingface').trim().toLowerCase(),
  embeddingDim: Number(process.env.EMBEDDING_DIM || 384),

  groqApiKey: process.env.GROQ_API_KEY || '',
  groqModel: process.env.GROQ_MODEL || '',

  storageBackend: process.env.STORAGE_BACKEND || 'local',
  storageLocalDir: process.env.STORAGE_LOCAL_DIR || './data/books',

  // Ingestion / chunking configuration lives in one place (never scattered).
  ingest: {
    chunkTargetTokens: Number(process.env.CHUNK_TARGET_TOKENS || 200),
    chunkMaxTokens: Number(process.env.CHUNK_MAX_TOKENS || 320),
    chunkOverlapTokens: Number(process.env.CHUNK_OVERLAP_TOKENS || 30),
    embeddingBatchSize: Number(process.env.EMBEDDING_BATCH_SIZE || 32),
    embeddingRetries: Number(process.env.EMBEDDING_RETRIES || 4),
    embeddingRetryBaseMs: Number(process.env.EMBEDDING_RETRY_BASE_MS || 500),
    // Hard per-request ceiling so a blocked/slow provider can never hang a job.
    embeddingTimeoutMs: Number(process.env.EMBEDDING_TIMEOUT_MS || 30000),
    // Concurrency is intentionally 1 — one controlled batch at a time (§16).
    embeddingConcurrency: Number(process.env.EMBEDDING_CONCURRENCY || 1),
    dbWriteBatchSize: Number(process.env.DB_WRITE_BATCH_SIZE || 200),
  },
};

// Which env vars each supported vendor needs. Keeping the list here means the
// provider factory, health and startup warnings can never disagree about what
// "configured" means. Values are never read from this table — only presence.
const PROVIDER_ENV_KEYS = {
  huggingface: ['hfApiKey', 'hfEmbeddingModel'],
  jina: ['jinaApiKey', 'jinaEmbeddingModel'],
};

export function embeddingReady() {
  const keys = PROVIDER_ENV_KEYS[env.embeddingProvider];
  if (!keys) return false;
  return keys.every((k) => Boolean(env[k]));
}

export function assertEnv() {
  const problems = [];
  if (env.isProd) {
    for (const key of requiredInProd) {
      if (!process.env[key]) problems.push(`${key} is required in production`);
    }
    // Never allow a wildcard or a localhost origin for authenticated APIs.
    if (env.corsOrigins.includes('*')) {
      problems.push('CORS_ORIGINS must not be "*" in production');
    }
    if (env.corsOrigins.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
      console.warn('[env] CORS_ORIGINS still contains a localhost origin in production');
    }
    if (!env.groqApiKey) console.warn('[env] GROQ_API_KEY not set — answers cannot be generated');
    // An incomplete embedding vendor is a degraded mode, not a boot failure:
    // retrieval falls back to real PostgreSQL full-text search. Warn only, and
    // never print values.
    if (!PROVIDER_ENV_KEYS[env.embeddingProvider]) {
      console.warn(`[env] unknown EMBEDDING_PROVIDER "${env.embeddingProvider}" (use jina or huggingface)`);
    } else if (!embeddingReady()) {
      console.warn(`[env] EMBEDDING_PROVIDER=${env.embeddingProvider} but its key/model env vars are incomplete — running lexical-only`);
    }
    if (env.storageBackend === 'supabase' && !(env.supabaseUrl && env.supabaseServiceRoleKey && env.supabaseStorageBucket)) {
      problems.push('STORAGE_BACKEND=supabase requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET');
    }
  }
  if (!env.jwtSecret) {
    problems.push('JWT_SECRET is not set — auth is disabled until it is configured');
  }
  if (problems.length) {
    // Log the problem, never the values.
    console.warn('[env] ' + problems.join('; '));
  }
  return { ok: env.isProd ? requiredInProd.every((k) => process.env[k]) : true };
}
