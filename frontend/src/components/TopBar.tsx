import { useAuth } from '../state/AuthContext';
import { useWorkspace } from '../state/WorkspaceContext';
import { BookSelector } from './BookSelector';

export function TopBar() {
  const { user, logout } = useAuth();
  const { selectedBook, selectedEdition } = useWorkspace();

  const status = !selectedBook ? 'idle' : selectedEdition ? 'ready' : 'loading';
  const statusText = status === 'ready' ? 'Ready' : status === 'loading' ? 'Loading' : 'No book';
  const dot =
    status === 'ready' ? 'bg-emerald-500' : status === 'loading' ? 'bg-amber-400' : 'bg-ink-faint';

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line bg-surface px-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex shrink-0 items-center gap-2">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className="text-accent">
            <path
              d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
          <span className="hidden font-serif text-base tracking-[0.14em] text-ink sm:inline">BOOKMARK</span>
        </span>
        <span className="hidden h-7 w-px bg-line sm:block" />
        <BookSelector />
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <span
          className="hidden items-center gap-2 rounded-full border border-line px-2.5 py-1 text-xs text-ink-muted md:flex"
          title="Whether an edition is loaded and searchable"
        >
          <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
          {statusText}
        </span>
        {user ? (
          <div className="flex items-center gap-2">
            <span className="hidden max-w-[16rem] truncate text-xs text-ink-muted lg:inline" title={user.email}>
              {user.email}
            </span>
            <button
              type="button"
              onClick={logout}
              className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}
