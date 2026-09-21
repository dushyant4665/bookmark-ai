import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '../state/WorkspaceContext';
import type { LibraryItem } from '../types';

// Reflects the real backend ingestion_status only — never invented values.
function statusText(item: LibraryItem): { label: string; tone: string } {
  switch (item.ingestionStatus) {
    case 'COMPLETED':
      return { label: 'Ready', tone: 'text-accent-strong' };
    case 'PROCESSING':
    case 'PENDING':
      return { label: 'Preparing', tone: 'text-ink-muted' };
    case 'FAILED':
      return { label: 'Needs attention', tone: 'text-red-600' };
    case 'NOT_INGESTED':
      return { label: 'Source only', tone: 'text-ink-muted' };
    default:
      // In the storage folder but never ingested: it cannot be read or asked
      // about yet, and saying so is the honest label.
      return item.bookId ? { label: 'Source only', tone: 'text-ink-muted' } : { label: 'Not indexed', tone: 'text-ink-muted' };
  }
}

function sizeText(item: LibraryItem): string | null {
  if (item.pageCount && item.chunkCount) return `${item.pageCount} pages · ${item.chunkCount} passages`;
  if (item.file.size) return `${Math.round(item.file.size / 1024 / 1024)} MB`;
  return null;
}

function editionStatus(status?: string | null): string {
  switch (status) {
    case 'COMPLETED':
      return 'Ready';
    case 'PROCESSING':
    case 'PENDING':
      return 'Preparing';
    case 'FAILED':
      return 'Needs attention';
    default:
      return '';
  }
}

// The catalog is the user's own storage folder (books/ in the bucket, or the
// managed local directory) — never a hardcoded list.
export function BookSelector() {
  const {
    library,
    libraryLoading,
    libraryError,
    librarySource,
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
    : libraryLoading
      ? 'Loading books…'
      : libraryError
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
              {editionStatus(selectedEdition?.ingestionStatus)
                ? ` · ${editionStatus(selectedEdition?.ingestionStatus)}`
                : ''}
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
          {libraryLoading ? <li className="px-3 py-2 text-sm text-ink-muted">Loading…</li> : null}
          {!libraryLoading && libraryError ? <li className="px-3 py-2 text-xs text-ink-muted">{libraryError}</li> : null}
          {!libraryLoading && !libraryError && library.length === 0 ? (
            <li className="px-3 py-2 text-sm text-ink-muted">
              No PDFs found{librarySource?.prefix ? ` in ${librarySource.prefix}` : ''}.
            </li>
          ) : null}

          {library.map((item) => {
            const status = statusText(item);
            const disabled = !item.bookId || !item.editionId;
            const selected = item.bookId && item.bookId === selectedBook?.id;
            const meta = [item.author || 'Unknown author', sizeText(item)].filter(Boolean).join(' · ');
            return (
              <div key={item.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={Boolean(selected)}
                  disabled={disabled}
                  title={
                    disabled
                      ? 'This PDF is in the library folder but has not been indexed yet. Ingest it to make it searchable.'
                      : undefined
                  }
                  onClick={() => {
                    if (disabled || !item.bookId) return;
                    selectBook(item.bookId, item.editionId);
                    setOpen(false);
                  }}
                  className={`w-full rounded px-3 py-2 text-left text-sm ${
                    disabled
                      ? 'cursor-not-allowed opacity-60'
                      : `hover:bg-surface-sunken ${selected ? 'bg-accent-soft' : ''}`
                  }`}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-medium text-ink">{item.title}</span>
                    <span className={`shrink-0 text-[11px] ${status.tone}`}>{status.label}</span>
                  </span>
                  <span className="block truncate text-xs text-ink-muted">{meta}</span>
                </button>

                {selected && !editionsLoading && editions.length > 1 ? (
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
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
