import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import type { Edition } from '../types';

// Reflects the real backend ingestion_status only — never invented values.
function statusText(e: Edition): string {
  switch (e.ingestionStatus) {
    case 'COMPLETED':
      return 'Ready';
    case 'PROCESSING':
    case 'PENDING':
      return 'Preparing';
    case 'FAILED':
      return 'Needs attention';
    default:
      return e.hasSource ? 'Source only' : 'No source';
  }
}

// Loads books from the backend. The catalog is never hardcoded here.
export function BookSelector() {
  const {
    books,
    booksLoading,
    booksError,
    selectedBook,
    editions,
    editionsLoading,
    selectedEdition,
    selectBook,
    selectEdition,
  } = useWorkspace();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const label = selectedBook
    ? selectedBook.title
    : booksLoading
      ? 'Loading books…'
      : booksError
        ? 'Books unavailable'
        : 'Select a book';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded px-3 py-1.5 text-left hover:bg-surface-sunken"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium text-ink">{label}</span>
          {selectedBook ? (
            <span className="block truncate text-xs text-ink-muted">
              {selectedBook.author || 'Unknown author'}
              {editions.length > 1 && selectedEdition?.label ? ` · ${selectedEdition.label}` : ''}
              {selectedEdition ? ` · ${statusText(selectedEdition)}` : ''}
            </span>
          ) : null}
        </span>
        <svg width="14" height="14" viewBox="0 0 20 20" className="text-ink-faint" aria-hidden>
          <path d="M6 8l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute z-30 mt-1 max-h-96 w-80 overflow-auto rounded-lg border border-line bg-surface p-1 shadow-lg bm-scroll"
        >
          {booksLoading ? <li className="px-3 py-2 text-sm text-ink-muted">Loading…</li> : null}
          {!booksLoading && booksError ? <li className="px-3 py-2 text-sm text-ink-muted">{booksError}</li> : null}
          {!booksLoading && !booksError && books.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-muted">No books in the library yet.</li>
          ) : null}

          {books.map((b) => (
            <div key={b.id}>
              <button
                type="button"
                role="option"
                aria-selected={b.id === selectedBook?.id}
                onClick={() => {
                  selectBook(b.id);
                  setOpen(false);
                }}
                className={`w-full rounded px-3 py-2 text-left text-sm hover:bg-surface-sunken ${
                  b.id === selectedBook?.id ? 'bg-accent-soft' : ''
                }`}
              >
                <span className="block font-medium text-ink">{b.title}</span>
                <span className="block text-xs text-ink-muted">{b.author || 'Unknown author'}</span>
              </button>

              {b.id === selectedBook?.id && !editionsLoading && editions.length > 1 ? (
                <div className="mb-1 ml-3 flex flex-wrap gap-1">
                  {editions.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => selectEdition(e.id)}
                      className={`rounded border px-2 py-0.5 text-xs ${
                        e.id === selectedEdition?.id
                          ? 'border-accent bg-accent text-white'
                          : 'border-line text-ink-muted hover:bg-surface-sunken'
                      }`}
                    >
                      {e.label || 'Edition'}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
