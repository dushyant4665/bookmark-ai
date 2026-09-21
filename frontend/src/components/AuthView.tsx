import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../state/AuthContext';
import { ApiError } from '../lib/api';
import { Spinner } from './ui';

const COPY: Record<string, string> = {
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  EMAIL_TAKEN: 'That email is already registered.',
  AUTH_NOT_CONFIGURED: 'Authentication is not configured on the server yet.',
  DATABASE_UNAVAILABLE: 'The database is not reachable. Start Postgres and run the migration.',
  VALIDATION_ERROR: 'Enter a valid email and a password of at least 8 characters.',
  NETWORK_ERROR: 'Cannot reach the server.',
};

const PROMISES = [
  ['Page numbers you can verify', 'Every citation resolves to a stored passage in the PDF you are reading.'],
  ['The exact lines, highlighted', 'Click a source and the reader opens the page with the real text boxes outlined.'],
  ['An honest “not in this book”', 'When the evidence cannot carry the question, it stops instead of inventing one.'],
];

export function AuthView({ mode: initialMode = 'login' }: { mode?: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>(initialMode);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'NETWORK_ERROR';
      setError(COPY[code] || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const switchTo = (next: 'login' | 'register') => {
    setMode(next);
    setError(null);
    window.location.hash = next === 'login' ? '#/signin' : '#/register';
  };

  return (
    <div className="min-h-full">
      <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <aside className="hidden flex-col justify-between border-r border-line bg-accent-soft px-10 py-9 lg:flex">
        <a href="#/" className="flex items-center gap-2" aria-label="Back to BOOKMARK">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className="text-accent">
            <path
              d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
          <span className="font-serif text-base tracking-[0.14em] text-ink">BOOKMARK</span>
        </a>

        <div>
          <h2 className="max-w-md font-serif text-3xl leading-snug tracking-tight text-ink">
            Ask the book. Get the passage.
          </h2>
          <ul className="mt-8 space-y-5">
            {PROMISES.map(([t, d]) => (
              <li key={t} className="max-w-md">
                <p className="text-sm font-medium text-ink">{t}</p>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{d}</p>
              </li>
            ))}
          </ul>
        </div>

        <p className="text-xs text-ink-faint">
          Answers are drawn only from the edition currently open in your reader.
        </p>
      </aside>

      <main className="flex items-center justify-center px-5 py-12">
        <form onSubmit={onSubmit} className="w-full max-w-sm">
          <a href="#/" className="mb-8 inline-block text-xs text-ink-muted hover:text-ink lg:hidden">
            ← Back
          </a>

          <h1 className="font-serif text-2xl tracking-tight text-ink">
            {mode === 'login' ? 'Welcome back' : 'Create your account'}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            {mode === 'login'
              ? 'Sign in to pick up where you left off.'
              : 'A library account, scoped to your own conversations.'}
          </p>

          <div className="mt-6 mb-6 grid grid-cols-2 gap-1 rounded-lg bg-surface-sunken p-1 text-sm">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchTo(m)}
                aria-pressed={mode === m}
                className={`rounded px-3 py-1.5 ${
                  mode === m ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-muted hover:text-ink'
                }`}
              >
                {m === 'login' ? 'Sign in' : 'Register'}
              </button>
            ))}
          </div>

          <label className="mb-1 block text-xs font-medium text-ink-muted" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mb-4 w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-accent"
          />

          <label className="mb-1 block text-xs font-medium text-ink-muted" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mb-2 w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-accent"
          />
          {mode === 'register' ? (
            <p className="mb-2 text-xs text-ink-faint">At least 8 characters.</p>
          ) : null}

          {error ? (
            <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" role="alert">
              {error}
            </p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="mt-2 flex w-full items-center justify-center rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-60"
          >
            {busy ? <Spinner /> : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
      </main>
      </div>
    </div>
  );
}
