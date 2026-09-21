# BOOKMARK — Deployment Guide

BOOKMARK is a grounded AI book-research app: a real PDF is ingested into
Postgres (pgvector + full-text search), questions are answered with citations
that point back to the exact source passage, and clicking a citation opens the
PDF on the right page with the passage highlighted from stored coordinates.

All secrets live only in the backend. The frontend never sees a database URL,
API key, or service-role key — it talks only to the backend HTTP/SSE API.

```
USER → Vercel (React + PDF.js) → HTTPS/SSE → Render (Express)
                                                 ├─ Supabase Postgres (schema "bookmark": pgvector + FTS)
                                                 ├─ Supabase Storage (production PDF, byte-range served)
                                                 ├─ Groq (grounded generation)
                                                 └─ Embeddings: Jina or HuggingFace (EMBEDDING_PROVIDER)
```

---

## 1. Supabase setup

1. Create a Supabase project (or reuse one — BOOKMARK is safe to share because
   it lives in its own schema).
2. Copy the **connection string**: Project Settings → Database →
   `Connection string` → URI. Use the pooled connection string for the app and
   the direct one for migrations if behind a pgbouncer.
3. In Postgres, the extension is enabled by the migration (`CREATE EXTENSION
   IF NOT EXISTS vector`). Supabase supports pgvector; no manual step needed.
4. Set `PGSCHEMA=bookmark`. All BOOKMARK tables live there, so a shared project
   never touches another app's `public` tables.

## 2. Storage bucket

1. Supabase → Storage → **New bucket**. Name it e.g. `books`.
2. Set the bucket **private** (the app reads it with the service-role key
   server-side and streams to the browser; the browser never gets the key).
3. Set `SUPABASE_STORAGE_BUCKET=books` and `STORAGE_BACKEND=supabase` in the
   backend environment.

## 3. PDF upload (publish a book to production storage)

`npm run publish:storage` uploads the local source PDF to the bucket,
**downloads it back, recomputes SHA-256, and refuses to switch the source** if
the hash does not match the indexed `book_sources.sha256`. Only on a match does
it mark the source as served from Supabase.

```bash
# preview (no writes)
node scripts/publish-storage.mjs --slug brothers-karamazov --edition db-seeded --dry-run
# real upload + integrity check + switch
node scripts/publish-storage.mjs --slug brothers-karamazov --edition db-seeded
```

## 4. Database migration

Idempotent, transactional, schema-scoped. Re-running is safe.

```bash
npm run migrate        # applies src/db/schema.sql into PGSCHEMA
```

## 5. Ingestion

Parse a real PDF → pages → chunks (with per-span coordinates) → embeddings (if
a provider is reachable) → store in `bookmark` tables.

```bash
npm run ingest:book -- --book <slug> --edition <label> --file <path.pdf> [--title ... --author ...]
# structural dry run (no embeddings):
npm run ingest:book -- --book <slug> --edition <label> --file <path.pdf> --no-embed
```

### Backfilling embeddings (resumable, safe, source-scoped)

Once the book is ingested, populate real pgvector embeddings for the chunks that
are still `NULL` — without re-parsing the PDF and without touching text, pages,
coordinates or citations:

```bash
npm run ingest:embeddings -- --book <slug> --edition <label>
```

Guarantees (this job never auto-runs on server boot — it is an explicit command):

- Runs **one** live provider probe first. If the provider is unreachable it stops
  with `EMBEDDING_PROVIDER_UNAVAILABLE` and leaves the database unchanged (no
  flood of failing requests).
- Verifies the measured dimension equals `EMBEDDING_DIM` (and the column type);
  a mismatch stops with `EMBEDDING_DIMENSION_MISMATCH` (reported as
  `JINA_EMBEDDING_DIMENSION_MISMATCH expected=<column> actual=<vendor>` for Jina)
  and never auto-migrates.
- Only rows with `embedding IS NULL` are selected, so re-running **resumes** where
  a crash/outage stopped — already-embedded chunks are never regenerated.
- Writes in bounded batches (`EMBEDDING_BATCH_SIZE`), each in its own transaction;
  a failed batch rolls back while earlier committed batches persist.
- Takes a PostgreSQL advisory lock per source; a second concurrent job returns
  `EMBEDDING_JOB_ALREADY_RUNNING`.

When the provider later becomes reachable, just re-run the same command.

## 6. Embedding verification

```bash
npm run verify:book -- --book <slug> --edition <label>   # DB-only: pages/chunks/dims/coords
npm run verify:production                                 # full readiness gate (see §12)
```

`verify:production` probes the embedding provider **live**. If the provider is
network-blocked it reports `WARN — provider unreachable … running
lexical-only` (an honest, documented degradation), not a fake pass. Retrieval
falls back to full-text search automatically; citations and highlighting still
work because they come from stored coordinates, not embeddings.

## 7. Render backend deployment

1. New **Web Service** → connect the repo → Root directory `backend`.
2. Build command `npm install`; Start command `npm start`.
3. Health check path `/api/health` (always HTTP 200; body reports real states).
4. Add the environment variables in §8. Render injects `PORT`; the app reads it.
5. The server handles `SIGTERM` (graceful drain + pool close) for zero-downtime
   redeploys.

## 8. Render environment variables

| Variable | Value / notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | fresh 64-hex secret (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| `JWT_EXPIRES_IN` | e.g. `7d` |
| `DATABASE_URL` | Supabase Postgres connection string |
| `PGSCHEMA` | `bookmark` |
| `SUPABASE_URL` | project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **backend only** — never to the browser |
| `SUPABASE_STORAGE_BUCKET` | e.g. `books` |
| `STORAGE_BACKEND` | `supabase` |
| `GROQ_API_KEY` / `GROQ_MODEL` | generation |
| `EMBEDDING_PROVIDER` | `jina` (or `huggingface`) — the vendor is never inferred |
| `JINA_API_KEY` / `JINA_EMBEDDING_MODEL` | Jina embeddings, e.g. `jina-embeddings-v3` |
| `EMBEDDING_DIM` | `384` — the width of `literature_chunks.embedding`; it is also the `dimensions` requested from Jina, so no migration is needed |
| `HUGGINGFACE_API_KEY` / `HF_EMBEDDING_MODEL` | only if `EMBEDDING_PROVIDER=huggingface` |
| `EMBEDDING_BATCH_SIZE` / `EMBEDDING_RETRIES` / `EMBEDDING_RETRY_BASE_MS` | backfill batching + bounded retries |
| `EMBEDDING_TIMEOUT_MS` | hard per-request ceiling so a blocked provider can't hang a job |
| `EMBEDDING_CONCURRENCY` | keep `1` — one controlled batch at a time |
| `CORS_ORIGINS` | your frontend origin(s), comma-separated — never `*` |
| `PG_POOL_MAX` / `PG_CONNECT_TIMEOUT_MS` / `PG_IDLE_TIMEOUT_MS` | optional pool tuning (defaults are fine on one instance) |
| `RATE_LIMIT` / `RATE_LIMIT_FACTOR` | optional; keep `true`, scale with the factor |
| `RAG_DEBUG` | unset/`false` (debug detail only when explicitly enabled) |

### Render gotchas

- **Database URL**: use the **direct / session pooler** connection (port `5432`).
  The transaction pooler (`6543`, `?pgbouncer=true`) breaks session-scoped
  features this app uses — the `search_path` option and the advisory lock that
  keeps two embedding jobs from overlapping.
- **Proxy**: the app sets `trust proxy`, so `X-Forwarded-For` is honoured and the
  per-client auth/login limits stay per-client behind Render's load balancer.
- **Free/hobby instances sleep.** A cold start aborts an in-flight SSE stream; the
  client reports the truncated answer honestly instead of pretending it finished.
  Keep the service awake (paid instance or a health-check pinger) if streaming
  latency matters.
- **One instance only** for now: rate-limit counters are in-memory, so scaling out
  makes the limits per-instance.
- Set the service's **Health Check Path** to `/api/health`.

## 8b. Render frontend (Static Site)

1. New **Static Site** → root directory `frontend`, Build `npm install && npm run
   build`, Publish directory `dist`.
2. Enable **SPA** in the site settings (or add `public/_redirects` with
   `/* /index.html 200`) so client routes resolve.
3. A static site has **no `/api` proxy** — that only exists in Vite dev. The
   frontend must be given the absolute backend URL (see §10).
4. After both deploy, `npm run verify:production` from the backend and load
   `https://<frontend>/` — sign in, pick a book, ask one question, click a source.

## 9. Vercel frontend deployment

1. Import the repo → Root directory `frontend`, Framework **Vite**.
2. Build `npm run build`, output `dist`. `vercel.json` rewrites all routes to
   `index.html` (SPA).
3. `npm run build` output is scanned: it must contain **no** secret patterns
   (verified clean). The frontend only knows its own public API base URL.

## 10. Vercel environment variable

| Variable | Value |
| --- | --- |
| `VITE_API_BASE_URL` | `https://<your-render-service>.onrender.com/api` |

This is baked in at **build time**, so set it before building and redeploy after
changing it. Everything the browser fetches/SSE-connects goes to that base. No
other frontend config — nothing secret reaches the bundle.

## 11. CORS

The backend allows only origins listed in `CORS_ORIGINS`. In production:
- `*` is rejected by `assertEnv()`.
- localhost origins trigger a warning.
- Set it to the exact Vercel URL(s). Authenticated SSE + JSON both rely on
  credentialed CORS being explicit — never wildcard.

## 12. Production verification

Run from the backend with the production environment loaded:

```bash
npm run verify:production
```

Checks: env vars present, CORS non-wildcard, DB `SELECT 1`, pgvector extension,
required tables, GIN/vector indexes, every COMPLETED source's PDF hash == DB
hash (`SOURCE_VERSION_MISMATCH` → FAIL), Supabase object reachable, live
embedding dimension, Groq reachable. Exits non-zero on a **critical** failure;
unreachable embeddings/absent vectors surface as documented WARN, not a fake
green.

## 13. How to add / re-ingest a book

```bash
# 1. ingest a new edition
npm run ingest:book -- --book my-book --edition default --file ./my-book.pdf --title "My Book" --author "A. N. Author"
# 2. publish its PDF to production storage (with hash check)
node scripts/publish-storage.mjs --slug my-book --edition default
# 3. verify
npm run verify:book -- --book my-book --edition default
npm run verify:production
```

To refresh an existing book without breaking conversations, reuse the same
slug/edition ids (see `scripts/reingest.mjs` for the pattern); `--force` rebuilds
even when the source hash already exists.

## 14. Troubleshooting

- **`SOURCE_VERSION_MISMATCH`** — the stored PDF is not the indexed one. The
  highlight/page mapping would be wrong, so publishing refuses the switch.
  Re-publish the exact PDF that was ingested.
- **`EMBEDDING_NETWORK` / lexical-only warnings** — the embedding host is
  unreachable from this network. Search still works via FTS; vector/hybrid
  activate automatically once the provider is reachable. Never fake a vector.
- **`STORAGE_UPLOAD_400`** — uploads must go to `/storage/v1/object/{bucket}/{key}`
  (the `…/authenticated/…` path is read-only). Handled by the provider; check
  bucket name and that the key is private.
- **CORS errors in the browser** — `CORS_ORIGINS` on Render must exactly match
  the Vercel origin (scheme + host), and the frontend `VITE_API_BASE_URL` must
  point at the Render URL.
- **SSE stops mid-answer** — the frontend treats a stream that closes without a
  terminal `complete`/`error` event as a failure and says so; it never renders a
  partial stream as a completed answer. Check Render's request timeout and that
  the proxy buffers SSE (the server sends keep-alive comments every 15s).
- **`DATABASE_URL is not set`** — the app still boots and reports an honest
  `database: not_configured` health state rather than crashing.
```
