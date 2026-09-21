import type { Book, ChatMessage, Conversation, Edition, Evidence, SourceRect, User } from '../types';

const BASE = import.meta.env.VITE_API_BASE_URL || '/api';
const TOKEN_KEY = 'bookmark.token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  const token = tokenStore.get();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 204) return undefined as T;

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const code = (data as { error?: string })?.error || `HTTP_${res.status}`;
    throw new ApiError(res.status, code);
  }
  return data as T;
}

// --- backend snake_case -> frontend camelCase mappers ---
const mapBook = (b: any): Book => ({ id: b.id, title: b.title, author: b.author ?? null, description: b.description ?? null });
const mapEdition = (e: any): Edition => ({
  id: e.id,
  label: e.label ?? null,
  language: e.language ?? null,
  totalPages: e.total_pages ?? null,
  hasSource: Boolean(e.has_source),
  ingestionStatus: e.ingestion_status ?? 'NOT_INGESTED',
});
const mapConversation = (c: any): Conversation => ({
  id: c.id,
  bookId: c.book_id,
  editionId: c.edition_id,
  title: c.title ?? null,
  createdAt: c.created_at,
  updatedAt: c.updated_at,
});

// A backend citation is already resolved to real DB rows. Map only structured
// fields the UI renders — the UI never parses pages or text from prose. Rects
// are real PDF user-space boxes (from the page's stored text items) used for
// exact highlighting; they are empty when the source has no usable coordinates.
export const mapEvidence = (c: any): Evidence => ({
  id: c.evidenceId ?? c.chunkId,
  bookId: c.bookId,
  editionId: c.editionId,
  sourceId: c.sourceId ?? null,
  pageId: c.pageId ?? null,
  pageNumber: c.page ?? c.pageStart ?? 1,
  pageStart: c.pageStart ?? c.page ?? null,
  pageEnd: c.pageEnd ?? c.pageStart ?? null,
  chapter: c.chapter ?? null,
  excerpt: c.text ?? '',
  sourceText: c.text ?? '',
  spans: Array.isArray(c.spans) ? c.spans : [],
  coordinatesAvailable: Boolean(c.coordinatesAvailable),
  rects: Array.isArray(c.rects) ? (c.rects as SourceRect[]) : [],
  coordinates: null,
});

// Restored history. The backend resolves each stored citation back to its real
// chunk row, so a refreshed browser shows the same pages and highlight rects it
// did live — nothing is rebuilt from the answer prose.
const mapHistoryMessage = (m: any): ChatMessage => ({
  id: m.id,
  role: m.role === 'assistant' ? 'assistant' : 'user',
  content: m.content ?? '',
  evidence: Array.isArray(m.citations) ? m.citations.map(mapEvidence) : [],
});

export const api = {
  register: (email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => request<{ user: User }>('/auth/me'),

  books: async () => {
    const data = await request<{ books: any[] }>('/books');
    return data.books.map(mapBook);
  },
  book: async (bookId: string) => {
    const data = await request<{ book: any }>(`/books/${bookId}`);
    return mapBook(data.book);
  },
  editions: async (bookId: string) => {
    const data = await request<{ editions: any[] }>(`/books/${bookId}/editions`);
    return data.editions.map(mapEdition);
  },
  pdfUrl: (bookId: string, editionId: string) => `${BASE}/books/${bookId}/editions/${editionId}/pdf`,

  createConversation: async (input: { bookId: string; editionId: string; title?: string }) => {
    const data = await request<{ conversation: any }>('/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return mapConversation(data.conversation);
  },
  conversations: async (bookId: string, editionId: string) => {
    const data = await request<{ conversations: any[] }>(
      `/conversations?bookId=${encodeURIComponent(bookId)}&editionId=${encodeURIComponent(editionId)}`
    );
    return data.conversations.map(mapConversation);
  },
  messages: async (conversationId: string) => {
    const data = await request<{ conversation: any; messages: any[] }>(
      `/conversations/${encodeURIComponent(conversationId)}/messages`
    );
    return {
      conversation: mapConversation(data.conversation),
      messages: (data.messages ?? []).map(mapHistoryMessage),
    };
  },
};

export { BASE };
