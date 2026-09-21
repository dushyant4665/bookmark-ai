import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { PdfPanel } from './PdfPanel';
import type { PdfController } from './PdfPanel';
import { ChatPanel } from './ChatPanel';
import { TopBar } from './TopBar';
import { useWorkspace } from '../state/WorkspaceContext';
import type { Evidence } from '../types';

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : true
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function Workspace() {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const pdfRef = useRef<PdfController>(null);
  const { selectedBook, selectedEdition } = useWorkspace();
  const [leftPct, setLeftPct] = useState(58);
  const [tab, setTab] = useState<'reader' | 'chat'>('reader');
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);

  // Citation click → the PDF panel owns navigation + highlighting. We only act
  // when the citation belongs to the currently open book/edition (§27 scope).
  const openSource = useCallback(
    (e: Evidence) => {
      if (!selectedBook || !selectedEdition) return;
      if (e.bookId !== selectedBook.id || e.editionId !== selectedEdition.id) return;
      setActiveEvidenceId(e.id);
      setTab('reader');
      // Defer one frame so the PDF panel is mounted/committed (mobile tab) before
      // it receives the navigation + highlight command.
      requestAnimationFrame(() => pdfRef.current?.openEvidence(e));
    },
    [selectedBook, selectedEdition]
  );

  const startDrag = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    const container = splitRef.current;
    if (!container) return;
    const move = (ev: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setLeftPct(Math.min(72, Math.max(35, pct)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, []);

  if (!isDesktop) {
    return (
      <div className="flex h-full flex-col">
        <TopBar />
        <div className="flex shrink-0 border-b border-line bg-surface text-sm">
          {(['reader', 'chat'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`flex-1 py-2 capitalize ${
                tab === t ? 'border-b-2 border-accent font-medium text-ink' : 'text-ink-muted'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          <div className={`h-full ${tab === 'reader' ? '' : 'hidden'}`}>
            <PdfPanel ref={pdfRef} activeEvidenceId={activeEvidenceId} />
          </div>
          <div className={`h-full ${tab === 'chat' ? '' : 'hidden'}`}>
            <ChatPanel onOpenSource={openSource} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div ref={splitRef} className="flex min-h-0 flex-1">
        <div style={{ width: `${leftPct}%` }} className="min-w-0">
          <PdfPanel ref={pdfRef} activeEvidenceId={activeEvidenceId} />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') setLeftPct((p) => Math.max(35, p - 2));
            if (e.key === 'ArrowRight') setLeftPct((p) => Math.min(72, p + 2));
          }}
          className="group flex w-1.5 shrink-0 cursor-col-resize items-center justify-center bg-line hover:bg-accent-soft"
          title="Drag to resize"
        >
          <span className="h-8 w-0.5 rounded bg-ink-faint/40 group-hover:bg-accent" aria-hidden />
        </div>
        <div style={{ width: `${100 - leftPct}%` }} className="min-w-0">
          <ChatPanel onOpenSource={openSource} />
        </div>
      </div>
    </div>
  );
}
