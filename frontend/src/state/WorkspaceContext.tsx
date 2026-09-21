import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { useAuth } from './AuthContext';
import type { Book, Edition, LibraryItem } from '../types';

interface WorkspaceState {
  // The library folder in storage, joined to real ingestion state. This is what
  // the book selector shows — a PDF the user drops into the bucket appears here
  // without any code change.
  library: LibraryItem[];
  libraryLoading: boolean;
  libraryError: string | null;
  librarySource: { backend: string; bucket: string | null; prefix: string | null } | null;
  books: Book[];
  selectedBook: Book | null;
  editions: Edition[];
  editionsLoading: boolean;
  selectedEdition: Edition | null;
  selectBook: (bookId: string, preferredEditionId?: string | null) => void;
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
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [librarySource, setLibrarySource] = useState<WorkspaceState['librarySource']>(null);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);

  const [editions, setEditions] = useState<Edition[]>([]);
  const [editionsLoading, setEditionsLoading] = useState(false);
  const [selectedEditionId, setSelectedEditionId] = useState<string | null>(null);

  // The dropdown is keyed by storage file, but the rest of the app (chat,
  // reader, conversations) speaks book ids. Derive the book list from the
  // library so both views can never disagree about what exists.
  const books = useMemo<Book[]>(() => {
    const seen = new Map<string, Book>();
    for (const item of library) {
      if (!item.bookId) continue;
      if (!seen.has(item.bookId)) {
        seen.set(item.bookId, { id: item.bookId, title: item.title, author: item.author, description: null });
      }
    }
    return Array.from(seen.values());
  }, [library]);

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

  // Load the library once, when the workspace becomes available.
  useEffect(() => {
    let active = true;
    setLibraryLoading(true);
    api
      .library()
      .then(async (data) => {
        if (!active) return;
        setLibrary(data.items);
        setLibrarySource(data.storage);
        setLibraryError(
          data.storage.listingError
            ? `The storage folder could not be listed (${data.storage.listingError}).${data.databaseError ? ' Database: ' + data.databaseError : ''}`
            : data.databaseError
              ? `Ingestion state is unavailable (${data.databaseError}).`
              : null
        );
        const ids = new Set(data.items.map((i) => i.bookId).filter(Boolean));
        const stored = readStored(user?.id);
        if (stored && ids.has(stored.bookId)) {
          setSelectedBookId(stored.bookId);
          await loadEditions(stored.bookId, stored.editionId);
        }
      })
      .catch((err) => {
        if (!active) return;
        setLibrary([]);
        setLibraryError(err?.message || 'LIBRARY_FAILED');
      })
      .finally(() => active && setLibraryLoading(false));
    return () => {
      active = false;
    };
    // Re-running on `user` is what scopes the restored selection to the account.
  }, [user?.id, loadEditions]);

  const selectBook = useCallback(
    (bookId: string, preferredEditionId?: string | null) => {
      setSelectedBookId(bookId);
      remember({ bookId, editionId: preferredEditionId ?? null });
      void loadEditions(bookId, preferredEditionId);
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
      library,
      libraryLoading,
      libraryError,
      librarySource,
      books,
      selectedBook: books.find((b) => b.id === selectedBookId) ?? null,
      editions,
      editionsLoading,
      selectedEdition: editions.find((e) => e.id === selectedEditionId) ?? null,
      selectBook,
      selectEdition,
    }),
    [
      library,
      libraryLoading,
      libraryError,
      librarySource,
      books,
      selectedBookId,
      editions,
      editionsLoading,
      selectedEditionId,
      selectBook,
      selectEdition,
    ]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within WorkspaceProvider');
  return ctx;
}
