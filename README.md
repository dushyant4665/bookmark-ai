# BOOKMARK

Grounded AI research over real book PDFs. Ask a question about a book and get an
answer built only from passages that exist in that edition — with the page number
attached, and the exact lines highlighted in the reader when you click a source.

The product rule this whole codebase is built around: **the model never decides
what is true about the book.** Pages, passages and coordinates come from
PostgreSQL. The language model only arranges evidence it was handed.

## What it does

- **Real citations.** Every source is a `literature_chunks` row: page, chapter,
  text. Nothing is parsed back out of the answer prose.
- **Exact highlighting.** Chunks store character spans into the page's text;
  pages store the PDF's own text-run boxes. The two are joined at request time,
  so a citation highlights the actual lines — one rectangle per text run, aligned
  at any zoom. No coordinates on the page? The UI says so instead of drawing a box.
- **Hybrid retrieval.** PostgreSQL full-text search plus pgvector cosine search,
  fused with Reciprocal Rank Fusion, then reranked (remote cross-encoder when
  configured, honest hybrid order otherwise).
- **Editions are isolated.** Retrieval is scoped to book → edition → source, so a
  citation can never point at a different printing's page numbers.
- **An honest refusal.** When retrieval finds nothing that can carry the question,
  generation never starts: you get a specific note about what was searched, with
  `confidence: insufficient` and no sources attached.
- **Streaming with a real lifecycle.** SSE events (`request_received` →
  `retrieval_complete` → `generating` → `answer_chunk` → `sources_ready` →
  `complete`) drive the UI, and tokens are the model's actual deltas.
- **Conversations persist.** Messages are stored with the chunk ids they were
  grounded on; a refresh re-resolves them from the database, citations included.

## Layout

```
backend/          Express + PostgreSQL (Supabase) API
  src/db          pool, isolated `bookmark` schema, migration runner
  src/ingest      PDF parse → pages → chunks → embeddings → storage
  src/retrieval   vector + lexical search, evidence model, highlight geometry
  src/rag         query understanding, fusion, rerank, generation, validation
  src/services    research pipeline, Groq client, books, conversations, health
  src/routes      auth, books, chat (SSE), conversations, ingest, health
  test/           node:test suites — run with `npm test`, no network needed
frontend/         React + Vite + TypeScript
  src/components  landing page, auth, workspace, PDF reader, chat
  src/lib         typed API client, SSE chat transport
```

## Getting started

```bash
cd backend  && npm install && cp .env.example .env && npm run migrate && npm run dev
cd frontend && npm install && npm run dev
```

The Vite dev server proxies `/api` to the backend (see `frontend/vite.config.ts`).
Set the values in `backend/.env` — database URL, Supabase storage credentials,
Groq key, and optionally a Hugging Face embedding model. `.env` is git-ignored;
only `.env.example` belongs in the repo, and it holds variable names, never values.

Ingest a book (requires a text-layer PDF):

```bash
npm run ingest:book -- --pdf ./my-book.pdf --slug my-book --edition "First Edition"
npm run verify:book -- --slug my-book
```

Backfill embeddings for an already-ingested source — resumable, source-scoped,
and it writes only where `embedding IS NULL`:

```bash
npm run ingest:embeddings -- --book my-book --edition "First Edition"
```

It probes the provider once before touching the database, refuses to write if the
returned dimension does not match the column, commits per batch with rollback,
holds a PostgreSQL advisory lock so two runs cannot overlap, and takes its resume
point from the database rather than memory. If the provider is unreachable it
stops at the probe and changes nothing.

Production checks:

```bash
npm run verify:production   # tables, counts, vector state, index, routes, health
```

`GET /api/health` reports configuration truthfully — `configured` means an env
var exists, not that a provider answered. Vector state (index present, embeddings
populated) is reported separately from model configuration.

## Tests

```bash
cd backend && npm test
```

Network-free by construction: providers, database and Groq are injected, so the
suites cover retrieval fusion, citation resolution, highlight geometry, the
grounding rules in the prompts, the embedding job's crash/resume behaviour, auth,
rate limiting and ownership checks.

## Security posture

- All credentials live server-side. The browser only ever holds a JWT.
- Ownership is enforced on every book, edition, conversation and source read.
- Secrets never appear in logs, health responses or generated text.
- The app runs in its own PostgreSQL schema (`PGSCHEMA`) so it can share a project.
- Rate limiting, CORS allowlist, body size caps, and graceful shutdown on SIGTERM.

See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the hosted setup (Supabase schema,
Storage bucket, migrations, ingestion runbook, and the embeddings backfill).
