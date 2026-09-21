// Shared frontend data contracts. These mirror the backend's structured
// evidence — the UI must never parse page numbers or citations from prose.

export interface User {
  id: string;
  email: string;
  createdAt: string;
}

export interface Book {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
}

export interface Edition {
  id: string;
  label: string | null;
  language: string | null;
  totalPages: number | null;
  hasSource: boolean;
  ingestionStatus: 'NOT_INGESTED' | 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
}

// A real PDF user-space rectangle for one source text run (Phase 4 highlight).
// x/y are the text baseline origin, width/height the run's box — straight from
// the page's stored text items. The viewer converts these to DOM pixels with
// the live PDF.js viewport, so they stay aligned across zoom and rotation.
export interface SourceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// One grounded passage returned by the research backend. Every field here is
// resolved from PostgreSQL — the UI never parses pages or text from prose.
export interface Evidence {
  id: string;
  bookId: string;
  editionId: string;
  sourceId: string | null;
  pageId: string | null;
  pageNumber: number;
  pageStart: number | null;
  pageEnd: number | null;
  chapter?: string | null;
  excerpt: string;
  sourceText: string;
  // [{pageNumber,charStart,charEnd}] provenance offsets into the page text.
  spans: number[] | { pageNumber: number; charStart: number; charEnd: number }[];
  coordinatesAvailable: boolean;
  rects: SourceRect[];
  // Kept for the eventual pdfjs-text-quads path; null until then.
  coordinates?: number[][] | null;
}

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  // Each request owns a requestId so a late event from an aborted turn can never
  // contaminate a newer answer (§30). Assistant messages carry the id they streamed under.
  requestId?: string;
  role: Role;
  content: string;
  // Sources arrive as structured data, not parsed from the answer text.
  evidence?: Evidence[];
  streaming?: boolean;
  error?: string | null;
}

export interface Conversation {
  id: string;
  bookId: string;
  editionId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

// SSE lifecycle events the chat transport is designed to consume.
export type ChatStreamEvent =
  | 'message'
  | 'request_received'
  | 'context_resolved'
  | 'query_rewritten'
  | 'retrieval_skipped'
  | 'searching'
  | 'retrieval_complete'
  | 'reranking'
  | 'evidence_selected'
  | 'generating'
  | 'answer_chunk'
  | 'sources_ready'
  | 'validation_complete'
  | 'complete'
  | 'error';
