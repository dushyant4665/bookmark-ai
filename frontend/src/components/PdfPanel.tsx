import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import 'react-pdf/dist/esm/Page/AnnotationLayer.css';
import 'react-pdf/dist/esm/Page/TextLayer.css';
import { api, tokenStore } from '../lib/api';
import { useWorkspace } from '../state/WorkspaceContext';
import type { Evidence } from '../types';
import { EmptyState, Spinner, ErrorState } from './ui';

// Bundle the worker locally (no external CDN). pdfjs-dist ships with react-pdf.
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

export interface PdfController {
  openPage: (pageNumber: number) => void;
  // Navigate to a citation's exact page and highlight the real source passage.
  openEvidence: (evidence: Evidence) => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const GAP = 16;
const OVERSCAN = 3;
// Fallback height of one page at scale 1 (points). Actual pages render in-flow,
// so real heights govern layout; this only sizes the scroll window + spacers.
const EST_PAGE_HEIGHT = 792;

// A PDF user-space rect (baseline origin + box) → a CSS-pixel box for the given
// viewport. convertToViewportRectangle flips/flips/scales/rotates for us, so
// highlights survive zoom and rotation without storing DOM pixels.
function toCssRect(vp: any, r: { x: number; y: number; width: number; height: number }) {
  const [x0, y0, x1, y1] = vp.convertToViewportRectangle([r.x, r.y, r.x + r.width, r.y + r.height]);
  return {
    left: Math.min(x0, x1),
    top: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
}

// The page indicator must reflect the ACTUAL page under the top of the viewport,
// not an estimate from assumed page height (Phase 4 bug: it could read one off).
// We measure the real rendered react-pdf pages and pick the one crossing the
// reference line near the top of the scroll container.
function measureCurrentPage(el: HTMLElement, numPages: number): number {
  const markers = el.querySelectorAll<HTMLElement>('[data-page-number]');
  if (!markers.length) return 1;
  const refTop = el.getBoundingClientRect().top + el.clientHeight * 0.3;
  let current = 1;
  for (const m of Array.from(markers)) {
    const n = Number(m.getAttribute('data-page-number'));
    if (!Number.isFinite(n)) continue;
    const top = m.getBoundingClientRect().top;
    if (top <= refTop) current = n;
    else break;
  }
  return Math.min(numPages, Math.max(1, current));
}

export const PdfPanel = forwardRef<PdfController, { activeEvidenceId?: string | null }>(
  function PdfPanel({ activeEvidenceId }, ref) {
    const { selectedBook, selectedEdition } = useWorkspace();
    const scrollRef = useRef<HTMLDivElement>(null);
    const [scale, setScale] = useState(1.1);
    const [numPages, setNumPages] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [range, setRange] = useState({ start: 0, end: 12 });

    // The citation whose source text is currently highlighted.
    const [target, setTarget] = useState<{ evidenceId: string; pageNumber: number; rects: Evidence['rects'] } | null>(null);
    // pdfjs page proxies for rendered pages — the source of the live viewport.
    const pageProxies = useRef<Map<number, any>>(new Map());
    const [tick, setTick] = useState(0);
    // The citation we've already scrolled to. Reset on each new selection so a
    // later visibility change (panel was mounted but hidden on the chat tab)
    // re-applies navigation once it actually has a layout box.
    const scrolledFor = useRef<string | null>(null);

    const url = useMemo(
      () => (selectedBook && selectedEdition ? api.pdfUrl(selectedBook.id, selectedEdition.id) : null),
      [selectedBook, selectedEdition]
    );

    // Keep a fresh bearer token for pdfjs's own fetch of the authenticated PDF.
    const file = useMemo(
      () =>
        url
          ? { url, httpHeaders: { Authorization: `Bearer ${tokenStore.get() ?? ''}` } }
          : null,
        [url]
    );

    useEffect(() => {
      setNumPages(0);
      setCurrentPage(1);
      setRange({ start: 0, end: 12 });
      setTarget(null);
      pageProxies.current.clear();
      if (file) setStatus('loading');
      else setStatus('idle');
    }, [file]);

    const computeRange = useCallback(() => {
      const el = scrollRef.current;
      if (!el || !numPages) return;
      const est = EST_PAGE_HEIGHT * scale + GAP;
      const start = Math.max(0, Math.floor(el.scrollTop / est) - OVERSCAN);
      const visible = Math.ceil(el.clientHeight / est) + OVERSCAN * 2;
      const end = Math.min(numPages, start + visible);
      setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
      const page = measureCurrentPage(el, numPages);
      setCurrentPage((prev) => (prev === page ? prev : page));
    }, [numPages, scale]);

    useEffect(() => {
      computeRange();
    }, [computeRange]);

    const scrollToPage = useCallback(
      (pageNumber: number, behavior: ScrollBehavior = 'smooth') => {
        const el = scrollRef.current;
        if (!numPages || !el || el.clientHeight === 0) return false; // no layout box yet (hidden)
        const p = Math.min(numPages, Math.max(1, pageNumber));
        el.scrollTo({ top: (p - 1) * (EST_PAGE_HEIGHT * scale + GAP), behavior });
        return true;
      },
      [numPages, scale]
    );

    useImperativeHandle(
      ref,
      () => ({
        openPage: (pageNumber: number) => scrollToPage(pageNumber),
        openEvidence: (evidence: Evidence) => {
          const page = evidence.pageStart ?? evidence.pageNumber;
          // Only navigate when we actually know the page; never guess one.
          if (!Number.isFinite(page)) return;
          scrolledFor.current = null;
          // If the panel is currently hidden it has no layout box and the scroll
          // won't stick — the ResizeObserver below re-applies it on reveal.
          if (scrollToPage(page)) scrolledFor.current = evidence.id;
          setTarget({
            evidenceId: evidence.id,
            pageNumber: page as number,
            rects: evidence.rects ?? [],
          });
        },
      }),
      [scrollToPage]
    );

    // Re-apply navigation for the active citation whenever the panel can
    // actually scroll: after the page count is known, after zoom changes, or
    // when the panel becomes visible. If it's mounted-but-hidden (chat tab) the
    // scroll has no layout box, so we defer to the ResizeObserver below.
    useEffect(() => {
      if (!target || !numPages) return;
      if (scrolledFor.current === target.evidenceId) return;
      if (scrollToPage(target.pageNumber)) scrolledFor.current = target.evidenceId;
    }, [target?.evidenceId, target?.pageNumber, numPages, scale, scrollToPage]);

    // Keep the active citation's page in view when the zoom changes — otherwise
    // the (windowed) render range can drop that page and its highlight overlay.
    useEffect(() => {
      if (!target || !numPages) return;
      scrollToPage(target.pageNumber, 'auto');
    }, [scale]);

    // The mobile layout keeps the reader mounted but hidden while chatting. When
    // it becomes visible its scroll container goes from zero to real size — catch
    // that and complete any pending citation navigation.
    useEffect(() => {
      const el = scrollRef.current;
      if (!el || typeof ResizeObserver === 'undefined') return;
      const ro = new ResizeObserver(() => {
        if (!target || !numPages || el.clientHeight === 0) return;
        if (scrolledFor.current === target.evidenceId) return;
        if (scrollToPage(target.pageNumber, 'auto')) scrolledFor.current = target.evidenceId;
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, [target, numPages, scrollToPage]);

    // Recompute the highlight boxes from the LIVE viewport of the rendered page.
    // Re-runs on zoom (scale), when the target page renders (proxy arrives), and
    // whenever the active citation changes — so it never drifts from the text.
    const highlightBoxes = useMemo(() => {
      if (!target || !target.rects.length) return [];
      const proxy = pageProxies.current.get(target.pageNumber);
      if (!proxy) return [];
      let vp;
      try {
        vp = proxy.getViewport({ scale });
      } catch {
        return [];
      }
      return target.rects.map((r) => toCssRect(vp, r));
    }, [target, scale, tick, numPages]);

    // Clear the highlight if the active citation is no longer selected elsewhere.
    useEffect(() => {
      if (activeEvidenceId && target && activeEvidenceId !== target.evidenceId) {
        // The parent deselected/changed sources; drop our overlay too.
        setTarget((t) => (t && t.evidenceId !== activeEvidenceId ? t : t));
      }
    }, [activeEvidenceId, target]);

    const registerProxy = useCallback((pageNumber: number, page: any) => {
      pageProxies.current.set(pageNumber, page);
      // Only force a re-render for the page we actually highlight on.
      setTarget((t) => {
        if (t && t.pageNumber === pageNumber) setTick((n) => n + 1);
        return t;
      });
    }, []);

    const zoom = (dir: 1 | -1) => setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +(s + dir * 0.1).toFixed(2))));

    if (!selectedBook) {
      return (
        <EmptyState title="Choose a book to start researching." hint="Pick a title from the selector above." />
      );
    }

    const est = EST_PAGE_HEIGHT * scale + GAP;
    const topPad = range.start * est;
    const bottomPad = Math.max(0, (numPages - range.end) * est);
    const highlightActive = highlightBoxes.length > 0;

    return (
      <section className="flex h-full min-w-0 flex-col bg-surface-sunken" aria-label="PDF reader">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-line bg-surface px-3 text-sm">
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => zoom(-1)} disabled={scale <= MIN_SCALE} aria-label="Zoom out"
              className="h-7 w-7 rounded border border-line text-ink-muted hover:bg-surface-sunken disabled:opacity-40">−</button>
            <span className="w-12 text-center tabular-nums text-ink-muted">{Math.round(scale * 100)}%</span>
            <button type="button" onClick={() => zoom(1)} disabled={scale >= MAX_SCALE} aria-label="Zoom in"
              className="h-7 w-7 rounded border border-line text-ink-muted hover:bg-surface-sunken disabled:opacity-40">+</button>
          </div>
          <div className="text-ink-muted">
            Page <span className="tabular-nums text-ink">{numPages ? currentPage : '–'}</span>
            {' / '}
            <span className="tabular-nums text-ink">{numPages || '–'}</span>
          </div>
        </div>

        <div ref={scrollRef} onScroll={computeRange} className="bm-scroll relative flex-1 overflow-auto p-4">
          {!file ? (
            <EmptyState title="No PDF available for this edition." />
          ) : (
            <Document
              key={url}
              file={file}
              onLoadSuccess={(d) => {
                setNumPages(d.numPages);
                setStatus('ready');
                requestAnimationFrame(computeRange);
              }}
              onLoadError={() => setStatus('error')}
              loading={
                <div className="flex justify-center py-16">
                  <Spinner label="Loading PDF…" />
                </div>
              }
              error={<ErrorState message="The PDF failed to load. The book may be unavailable." />}
            >
              {status === 'error' ? null : (
                <div style={{ paddingTop: topPad, paddingBottom: bottomPad }}>
                  {Array.from({ length: Math.max(0, range.end - range.start) }, (_, i) => range.start + i + 1).map(
                    (p) => {
                      const isTargetPage = target && target.pageNumber === p;
                      return (
                        <div key={p} className="mb-4 flex justify-center">
                          <div className="relative">
                            <Page
                              pageNumber={p}
                              scale={scale}
                              renderTextLayer
                              renderAnnotationLayer
                              onRenderSuccess={(page: any) => registerProxy(p, page)}
                              className="rounded border border-line bg-white shadow-sm"
                            />
                            {/* Transparent highlight overlay: real source rects,
                                pointer-events-safe so selection/scroll still work. */}
                            {isTargetPage && highlightActive ? (
                              <div className="pointer-events-none absolute inset-0" aria-hidden>
                                {highlightBoxes.map((b, i) => (
                                  <div
                                    key={i}
                                    className="absolute rounded-[2px]"
                                    style={{
                                      left: b.left,
                                      top: b.top,
                                      width: b.width,
                                      height: b.height,
                                      background: 'rgba(250, 204, 21, 0.35)',
                                      boxShadow: '0 0 0 1px rgba(202, 138, 4, 0.35)',
                                    }}
                                  />
                                ))}
                              </div>
                            ) : null}
                            {isTargetPage && target && target.rects.length === 0 ? (
                              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center">
                                <span className="mt-2 rounded bg-surface px-2 py-0.5 text-[11px] text-ink-muted shadow-sm">
                                  Exact highlight unavailable for this source
                                </span>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    }
                  )}
                </div>
              )}
            </Document>
          )}
        </div>
      </section>
    );
  }
);
