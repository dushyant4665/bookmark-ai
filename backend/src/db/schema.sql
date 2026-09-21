-- BOOKMARK PostgreSQL schema (Phase 2: real ingestion pipeline)
-- Vector column width is injected by the migration runner from EMBEDDING_DIM,
-- and re-verified against the real provider output at ingestion time.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS books (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text UNIQUE,          -- stable identifier used by the ingest CLI
  title       text NOT NULL,
  author      text,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- BOOK -> EDITION -> SOURCE PDF -> PAGES -> CHUNKS
CREATE TABLE IF NOT EXISTS book_editions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id     uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  label       text,                 -- e.g. "default"
  language    text,
  total_pages integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (book_id, label)
);

-- One source PDF per edition. Carries the full ingestion lifecycle + version metadata.
CREATE TABLE IF NOT EXISTS book_sources (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edition_id        uuid NOT NULL UNIQUE REFERENCES book_editions(id) ON DELETE CASCADE,
  storage_backend   text NOT NULL DEFAULT 'local',
  storage_key       text NOT NULL,          -- relative path/key, never an absolute host path
  original_filename text,
  mime_type         text NOT NULL DEFAULT 'application/pdf',
  byte_size         bigint,
  sha256            text,                    -- content fingerprint for idempotency
  page_count        integer,
  parser_version    text,
  embedding_model   text,
  embedding_dim     integer,
  pdf_metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ingestion_status  text NOT NULL DEFAULT 'NOT_INGESTED'
    CONSTRAINT book_sources_status_check
      CHECK (ingestion_status IN ('NOT_INGESTED','PENDING','PROCESSING','COMPLETED','FAILED')),
  ingestion_error   text,
  ingest_job_id     text,
  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS book_sources_sha256_idx ON book_sources (sha256);

-- Real per-page extraction: dimensions, rotation, original + normalized text, and
-- text items WITH their PDF coordinates (or an explicit unavailable marker).
CREATE TABLE IF NOT EXISTS book_pages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  book_source_id        uuid REFERENCES book_sources(id) ON DELETE CASCADE,
  edition_id            uuid REFERENCES book_editions(id) ON DELETE CASCADE,
  page_number           integer NOT NULL,     -- 1-based, matches the actual PDF page index
  page_width            double precision,
  page_height           double precision,
  rotation              integer,
  raw_text              text,                 -- authoritative extracted text (may be empty)
  normalized_text       text,                 -- cleanup for chunking/search; never replaces raw_text
  char_count            integer,
  text_items            jsonb,                -- [{str,x,y,width,height,transform}] or null coords
  coordinates_available boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
-- One page row per source page; retries update in place (see migration for Phase 1 fallback).

-- Embedding-bearing, document-aware chunks with full provenance for Phase 3/4.
CREATE TABLE IF NOT EXISTS literature_chunks (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_uid             text UNIQUE,           -- deterministic hash (source+chunker+index+text)
  book_id               uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id            uuid NOT NULL REFERENCES book_editions(id) ON DELETE CASCADE,
  book_source_id        uuid REFERENCES book_sources(id) ON DELETE CASCADE,
  page_id               uuid REFERENCES book_pages(id) ON DELETE CASCADE,  -- primary (start) page
  page_number           integer,               -- == page_start, kept for compatibility
  page_start            integer NOT NULL,
  page_end              integer NOT NULL,
  chapter               text,                  -- detected section, or NULL (never invented)
  chunk_index           integer NOT NULL DEFAULT 0,
  source_text           text NOT NULL,          -- authoritative original text
  search_text           text NOT NULL,          -- normalized text used for embeddings + FTS
  spans                 jsonb NOT NULL DEFAULT '[]'::jsonb, -- [{pageNumber,charStart,charEnd}]
  coordinates_available boolean NOT NULL DEFAULT false,
  char_count            integer,
  token_count           integer,
  chunker_version       text,
  embedding             vector(__EMBEDDING_DIM__),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Lexical search column + GIN index (semantic vector index is built after real data).
CREATE INDEX IF NOT EXISTS literature_chunks_page_idx ON literature_chunks (edition_id, page_start);

CREATE TABLE IF NOT EXISTS conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  book_id    uuid NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  edition_id uuid NOT NULL REFERENCES book_editions(id) ON DELETE CASCADE,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  evidence        jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON conversation_messages (conversation_id, created_at);

-- =====================================================================
-- Idempotent evolution for databases created under Phase 1.
-- Fresh databases already have everything above; these are no-ops then.
-- =====================================================================
ALTER TABLE books                ADD COLUMN IF NOT EXISTS slug text UNIQUE;
ALTER TABLE book_editions         ADD COLUMN IF NOT EXISTS label text;

ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS page_count integer;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS parser_version text;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS embedding_dim integer;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS pdf_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS ingestion_status text NOT NULL DEFAULT 'NOT_INGESTED';
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS ingestion_error text;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS ingest_job_id text;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE book_sources          ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS book_source_id uuid REFERENCES book_sources(id) ON DELETE CASCADE;
ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS page_width double precision;
ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS page_height double precision;
ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS rotation integer;
ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS normalized_text text;
ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS text_items jsonb;
ALTER TABLE book_pages            ADD COLUMN IF NOT EXISTS coordinates_available boolean NOT NULL DEFAULT false;

ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS chunk_uid text UNIQUE;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS book_source_id uuid REFERENCES book_sources(id) ON DELETE CASCADE;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS page_start integer;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS page_end integer;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS search_text text;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS spans jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS coordinates_available boolean NOT NULL DEFAULT false;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS char_count integer;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS token_count integer;
ALTER TABLE literature_chunks     ADD COLUMN IF NOT EXISTS chunker_version text;
-- Backfill page_start/end for any pre-existing rows, then enforce NOT NULL.
UPDATE literature_chunks SET page_start = page_number, page_end = page_number WHERE page_start IS NULL;
UPDATE literature_chunks SET search_text = source_text WHERE search_text IS NULL;
ALTER TABLE literature_chunks     ALTER COLUMN page_start SET NOT NULL;
ALTER TABLE literature_chunks     ALTER COLUMN page_end   SET NOT NULL;
ALTER TABLE literature_chunks     ALTER COLUMN search_text SET NOT NULL;

-- The unique page constraint: source-scoped when a source exists. Added conditionally
-- so Phase 1 rows keyed only by edition don't block the migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'book_pages_source_page_key') THEN
    ALTER TABLE book_pages ADD CONSTRAINT book_pages_source_page_key UNIQUE (book_source_id, page_number);
  END IF;
END $$;

-- Generated full-text column + GIN index, added only once (PG generated columns
-- can't use IF NOT EXISTS).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'literature_chunks' AND column_name = 'search_tsv'
  ) THEN
    ALTER TABLE literature_chunks
      ADD COLUMN search_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', search_text)) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS literature_chunks_search_tsv_idx
  ON literature_chunks USING GIN (search_tsv);
