import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import type { Book, Edition } from '../types';

interface WorkspaceState {
  books: Book[];
  booksLoading: boolean;
  booksError: string | null;
  selectedBook: Book | null;
  editions: Edition[];
  editionsLoading: boolean;
  selectedEdition: Edition | null;
  selectBook: (bookId: string) => void;
  selectEdition: (editionId: string) => void;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

// The open book is remembered per account, so a refresh returns you to the page
// you were reading instead of an empty selector.
const LS_KEY = 'bookmark.workspace';

type Stored = { userId: string; bookId: string; editionId: string | null };

function readStored(userId: string | undefined): Stored | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    return parsed && parsed.userId === userId && parsed.bookId ? parsed : null;
  } catch {
    return null;
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [books, setBooks] = useState<Book[]>([]);
  const [booksLoading, setBooksLoading] = useState(true);
  const [booksError, setBooksError] = useState<string | null>(null);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);

  const [editions, setEditions] = useState<Edition[]>([]);
  const [editionsLoading, setEditionsLoading] = useState(false);
  const [selectedEditionId, setSelectedEditionId] = useState<string | null>(null);

  const remember = useCallback(
    (patch: Partial<Stored>) => {
      if (!user) return;
      const prev = readStored(user.id) ?? { userId: user.id, bookId: '', editionId: null };
      const next = { ...prev, ...patch, userId: user.id };
      if (!next.bookId) return;
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    },
    [user]
  );

  // Loading a book's editions is independent of chat state on purpose. A stored
  // edition wins over the default one so the refresh lands where you left off.
  const loadEditions = useCallback(async (bookId: string, preferredEditionId?: string | null) => {
    setEditionsLoading(true);
    setEditions([]);
    setSelectedEditionId(null);
    try {
      const list = await api.editions(bookId);
      setEditions(list);
      const wanted = preferredEditionId ? list.find((e) => e.id === preferredEditionId) : null;
      const chosen = wanted ?? list.find((e) => e.hasSource) ?? list[0];
      if (chosen) setSelectedEditionId(chosen.id);
    } catch {
      setEditions([]);
    } finally {
      setEditionsLoading(false);
    }
  }, []);

  // Load the catalog once, when the workspace becomes available.
  useEffect(() => {
    let active = true;
    setBooksLoading(true);
    api
      .books()
      .then(async (list) => {
        if (!active) return;
        setBooks(list);
        setBooksError(null);
        const stored = readStored(user?.id);
        if (stored && list.some((b) => b.id === stored.bookId)) {
          setSelectedBookId(stored.bookId);
          await loadEditions(stored.bookId, stored.editionId);
        }
      })
      .catch((err) => {
        if (!active) return;
        setBooks([]);
        setBooksError(err?.message || 'BOOKS_FAILED');
      })
      .finally(() => active && setBooksLoading(false));
    return () => {
      active = false;
    };
    // Re-running on `user` is what scopes the restored selection to the account.
  }, [user?.id, loadEditions]);

  const selectBook = useCallback(
    (bookId: string) => {
      setSelectedBookId(bookId);
      remember({ bookId, editionId: null });
      void loadEditions(bookId);
    },
    [loadEditions, remember]
  );

  const selectEdition = useCallback(
    (editionId: string) => {
      setSelectedEditionId(editionId);
      remember({ editionId });
    },
    [remember]
  );

  const value = useMemo<WorkspaceState>(
    () => ({
      books,
      booksLoading,
      booksError,
      selectedBook: books.find((b) => b.id === selectedBookId) ?? null,
      editions,
      editionsLoading,
      selectedEdition: editions.find((e) => e.id === selectedEditionId) ?? null,
      selectBook,
      selectEdition,
    }),
    [books, booksLoading, booksError, selectedBookId, editions, editionsLoading, selectedEditionId, selectBook, selectEdition]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
