import { useState } from 'react';
import type { Evidence } from '../types';

// Purely presentational: renders a structured citation from the backend. Every
// field (page, excerpt) is DB-sourced — nothing here is fabricated, and clicking
// hands the whole structured source to the viewer (no text parsing).
export function SourceCard({ evidence, onOpen }: { evidence: Evidence; onOpen?: (e: Evidence) => void }) {
  const [expanded, setExpanded] = useState(false);
  const start = evidence.pageStart ?? evidence.pageNumber;
  const end = evidence.pageEnd ?? start;
  const multiPage = end != null && start != null && end !== start;
  const pageLabel = multiPage ? `Pages ${start}–${end}` : `Page ${start}`;
  // A real highlight needs at least one genuine coordinate rectangle.
  const canHighlight = evidence.coordinatesAvailable && evidence.rects.length > 0;
  const isLong = evidence.excerpt.length > 320;

  return (
    <figure className="rounded-lg border border-line bg-surface p-3.5 transition-colors hover:border-accent/40">
      <figcaption className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
          {/^e\d+$/.test(evidence.id) ? `Source ${evidence.id}` : 'Source'}
        </span>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 font-serif text-[11px] text-accent-strong">
          {pageLabel}
          {evidence.chapter ? ` · ${evidence.chapter}` : ''}
        </span>
      </figcaption>

      <blockquote
        className={`mt-2 border-l-2 border-line pl-3 font-serif text-[13px] italic leading-relaxed text-ink-muted ${
          expanded || !isLong ? '' : 'line-clamp-4'
        }`}
      >
        “{evidence.excerpt}”
      </blockquote>

      <div className="mt-3 flex items-center justify-between gap-3">
        {isLong ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs font-medium text-ink-muted hover:text-ink"
          >
            {expanded ? 'Show less' : 'Show whole passage'}
          </button>
        ) : (
          <span className="text-[11px] text-ink-faint">
            {canHighlight ? 'Exact passage mapped on the page' : 'Coordinates unavailable'}
          </span>
        )}
        {onOpen ? (
          <button
            type="button"
            onClick={() => onOpen(evidence)}
            aria-label={`Open source on page ${start}`}
            className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2.5 py-1 text-xs font-medium text-accent-strong hover:border-accent hover:bg-accent-soft"
          >
            Open in reader <span aria-hidden>→</span>
          </button>
        ) : null}
      </div>

      {!canHighlight ? (
        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          Exact highlight unavailable for this source — the page will still open.
        </p>
      ) : null}
    </figure>
  );
}
