export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-ink-muted text-sm" role="status" aria-live="polite">
      <span
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent"
        aria-hidden
      />
      {label ? <span>{label}</span> : null}
    </div>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <h3 className="font-serif text-lg text-ink">{title}</h3>
      {hint ? <p className="mt-2 max-w-sm text-sm leading-relaxed text-ink-muted">{hint}</p> : null}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="m-4 rounded border border-line bg-surface-sunken px-4 py-3 text-sm text-ink-muted" role="alert">
      {message}
    </div>
  );
}
