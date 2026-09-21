import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { streamChat } from '../lib/chatStream';
import { api, mapEvidence } from '../lib/api';
import { useWorkspace } from '../state/WorkspaceContext';
import type { ChatMessage, ChatStreamEvent, Evidence } from '../types';
import { Message } from './Message';
import { EmptyState } from './ui';

let localId = 0;
const nextId = () => `local-${++localId}`;

// The citation payload moved from `citations` (Phase 3) to `sources` (Phase 4);
// accept either so the UI is stable across both.
const readSources = (data: any): Evidence[] =>
  (((data?.sources ?? data?.citations ?? []) as any[]) || []).map(mapEvidence);

// Question shapes, not claims about a book's contents — any title can answer them.
const SUGGESTIONS = [
  'What is this book really about?',
  'Which passages state it most directly?',
  'What does the author concede or reject?',
];

// Groq writes far faster than anyone can read, so raw SSE deltas are queued and
// revealed at a steady typing pace. While the model is still talking we type at
// reading speed; once its stream has ended the remainder drains quickly instead
// of leaving the UI typing at nothing.
const TYPE_CHARS_PER_SEC = 105;
const TYPE_TAIL_CHARS_PER_SEC = 340;
const TYPE_TICK_MS = 16;

export function ChatPanel({ onOpenSource }: { onOpenSource?: (e: Evidence) => void }) {
  const { selectedBook, selectedEdition, editions } = useWorkspace();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [activity, setActivity] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Each book/edition selection owns a turn number. A slow response from an
  // earlier selection must never overwrite the conversation now on screen.
  const turnRef = useRef(0);
  const typeRef = useRef({ id: '', queue: '', streamOpen: false, timer: 0, last: 0, onDrained: null as null | (() => void) });

  const appendNow = useCallback((id: string, piece: string) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, content: m.content + piece } : m)));
  }, []);

  const stopTyping = useCallback(() => {
    const t = typeRef.current;
    if (t.timer) window.clearInterval(t.timer);
    t.timer = 0;
    t.onDrained = null;
  }, []);

  // Text the model already produced is never thrown away — on Stop or an error
  // the undisplayed remainder is flushed in full before the message closes.
  const flushTyping = useCallback(() => {
    const t = typeRef.current;
    if (t.queue) appendNow(t.id, t.queue);
    t.queue = '';
    stopTyping();
  }, [appendNow, stopTyping]);

  const startTyping = useCallback(() => {
    const t = typeRef.current;
    if (t.timer) return;
    t.last = Date.now();
    t.timer = window.setInterval(() => {
      const elapsed = Date.now() - t.last;
      t.last = Date.now();
      if (!t.queue) {
        if (!t.streamOpen) {
          const done = t.onDrained;
          stopTyping();
          done?.();
        }
        return;
      }
      const rate = t.streamOpen ? TYPE_CHARS_PER_SEC : TYPE_TAIL_CHARS_PER_SEC;
      const want = Math.min(t.queue.length, Math.max(1, Math.round((rate * elapsed) / 1000)));
      // Break on a space where possible so words are typed, not chopped.
      const head = t.queue.slice(0, want);
      const space = head.lastIndexOf(' ');
      const cut = space > want * 0.5 ? space + 1 : want;
      const piece = t.queue.slice(0, cut);
      t.queue = t.queue.slice(cut);
      appendNow(t.id, piece);
    }, TYPE_TICK_MS);
  }, [appendNow, stopTyping]);

  useEffect(() => () => stopTyping(), [stopTyping]);

  // Restore the last conversation for this book/edition instead of starting
  // blank — the chat survives a page refresh.
  // Leaving a conversation mid-stream: drop the undisplayed remainder (the full
  // answer is already stored server-side and reloads from history).
  const resetTyping = useCallback(() => {
    const t = typeRef.current;
    t.queue = '';
    t.streamOpen = false;
    t.id = '';
    stopTyping();
  }, [stopTyping]);

  useEffect(() => {
    const turn = ++turnRef.current;
    abortRef.current?.abort();
    resetTyping();
    setMessages([]);
    setConversationId(null);
    setActivity(null);
    setBusy(false);
    if (!selectedBook || !selectedEdition) {
      setRestoring(false);
      return;
    }

    let cancelled = false;
    setRestoring(true);
    (async () => {
      try {
        const list = await api.conversations(selectedBook.id, selectedEdition.id);
        const latest = list[0];
        if (!latest || cancelled || turn !== turnRef.current) return;
        const history = await api.messages(latest.id);
        if (cancelled || turn !== turnRef.current) return;
        setConversationId(history.conversation.id);
        setMessages(history.messages);
      } catch {
        // No history to restore is a normal state, not an error worth showing.
      } finally {
        if (!cancelled && turn === turnRef.current) setRestoring(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedBook?.id, selectedEdition?.id]);

  const startNewChat = useCallback(() => {
    abortRef.current?.abort();
    turnRef.current += 1;
    resetTyping();
    setMessages([]);
    setConversationId(null);
    setActivity(null);
    setBusy(false);
    setRestoring(false);
  }, [resetTyping]);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  const patchAssistant = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const appendDelta = useCallback((id: string, delta: string) => {
    const t = typeRef.current;
    if (t.id && t.id !== id) {
      // A different answer took over: whatever the model already wrote is kept.
      if (t.queue) appendNow(t.id, t.queue);
      t.queue = '';
    }
    t.id = id;
    t.queue += delta;
    t.streamOpen = true;
    startTyping();
  }, [appendNow, startTyping]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !selectedBook || !selectedEdition) return;

    setInput('');
    setBusy(true);
    setActivity(null);

    let convoId = conversationId;
    try {
      if (!convoId) {
        const convo = await api.createConversation({ bookId: selectedBook.id, editionId: selectedEdition.id });
        convoId = convo.id;
        setConversationId(convoId);
      }
    } catch {
      convoId = conversationId;
    }

    const assistantId = nextId();
    setMessages((prev) => [
      ...prev,
      { id: nextId(), role: 'user', content: text },
      { id: assistantId, role: 'assistant', content: '', streaming: true, evidence: [] },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;
    // §17: distinguish a clean finish from a dropped stream. If neither a
    // `complete` nor an `error` arrived, the answer is truncated — not done.
    let sawTerminal = false;
    // The citations land while the answer is still being typed out. They are
    // shown when the message closes, not in its middle.
    let sources: Evidence[] = [];

    const close = (opts: Partial<ChatMessage> = {}) => {
      setBusy(false);
      setActivity(null);
      patchAssistant(assistantId, { streaming: false, evidence: sources, ...opts });
    };

    // A stream that ends while text is still queued keeps the message open
    // until the typed remainder reaches the screen.
    const finish = (opts: Partial<ChatMessage> = {}) => {
      const t = typeRef.current;
      t.streamOpen = false;
      if (!t.queue) {
        close(opts);
        return;
      }
      t.onDrained = () => close(opts);
      startTyping();
    };

    await streamChat(
      { conversationId: convoId ?? '', bookId: selectedBook.id, editionId: selectedEdition.id, message: text },
      {
        onEvent: (event: ChatStreamEvent, data: any) => {
          switch (event) {
            case 'request_received':
              patchAssistant(assistantId, { requestId: data.requestId });
              setActivity('Preparing…');
              break;
            case 'context_resolved':
              setActivity('Loading the book…');
              break;
            case 'query_rewritten':
              setActivity('Understanding your question…');
              break;
            case 'retrieval_skipped':
              // A conversational turn ("ok", "hindi me bta") has nothing to
              // search; saying so beats showing a fake "Searching…" state.
              setActivity('Answering…');
              break;
            case 'searching':
              setActivity('Searching the book…');
              break;
            case 'retrieval_complete':
              setActivity('Comparing candidate passages…');
              break;
            case 'reranking':
              setActivity('Ranking the most relevant passages…');
              break;
            case 'evidence_selected':
              setActivity('Reading the sources…');
              break;
            case 'generating':
              setActivity('Writing the answer…');
              break;
            case 'answer_chunk': {
              // Real token delta from Groq. Append, don't rebuild history.
              const delta = data.delta ?? data.text ?? '';
              if (delta) {
                setActivity(null);
                appendDelta(assistantId, delta);
              }
              break;
            }
            case 'sources_ready':
              sources = readSources(data);
              break;
            case 'validation_complete':
              setActivity(null);
              break;
            case 'complete':
              sawTerminal = true;
              finish();
              break;
            case 'error':
              sawTerminal = true;
              flushTyping();
              finish({ error: data.message || 'The research backend is being prepared.' });
              break;
            default:
              break;
          }
        },
        onError: () => {
          // A user-initiated Stop is an AbortError handled in the client; any
          // other end is a real failure. Never pretend generation completed.
          flushTyping();
          finish({ error: 'Chat failed or was interrupted. Please try again.' });
        },
        onClose: () => {
          // Stream ended. A user Stop is honest ("Stopped."). An unexpected
          // close with no terminal event means the answer was truncated — say
          // so; never present a partial stream as a completed answer (§17).
          flushTyping();
          if (controller.signal.aborted) {
            finish({ error: 'Stopped.' });
          } else if (!sawTerminal) {
            finish({ error: 'The connection ended before the answer finished. Please try again.' });
          } else {
            finish();
          }
        },
      },
      controller.signal
    );
  }, [input, busy, selectedBook, selectedEdition, conversationId, patchAssistant, appendDelta, startTyping, flushTyping]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const applySuggestion = (text: string) => setInput(text);

  if (!selectedBook) {
    return <EmptyState title="Choose a book to start researching." />;
  }

  return (
    <section className="flex h-full min-w-0 flex-col bg-surface" aria-label="AI research">
      <div className="shrink-0 border-b border-line px-5 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate font-serif text-base text-ink" title={selectedBook.title}>
              {selectedBook.title}
            </h2>
            <p className="truncate text-xs text-ink-muted">
              {/* A single edition needs no label — naming it only adds noise. */}
              {editions.length > 1 && selectedEdition?.label ? `${selectedEdition.label} · ` : ''}
              Answers are grounded in this edition.
            </p>
          </div>
          {messages.length > 0 ? (
            <button
              type="button"
              onClick={startNewChat}
              className="shrink-0 rounded border border-line px-2.5 py-1 text-xs font-medium text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              New chat
            </button>
          ) : null}
        </div>
      </div>

      <div ref={scrollRef} className="bm-scroll flex-1 space-y-4 overflow-auto px-5 py-4">
        {restoring ? (
          <p className="text-xs italic text-ink-faint" aria-live="polite">Reopening your last conversation…</p>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center">
            <EmptyState
              title="Ask your first question"
              hint="Find arguments, themes, characters, passages, and ideas in this book."
            />
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => applySuggestion(s)}
                  className="rounded-full border border-line bg-surface-sunken px-3 py-1.5 text-xs text-ink-muted hover:border-accent hover:text-accent-strong"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} message={m} onOpenSource={onOpenSource} />)
        )}
        {activity ? <p className="text-xs italic text-ink-faint" aria-live="polite">{activity}</p> : null}
      </div>

      <div className="shrink-0 border-t border-line bg-surface-sunken p-3">
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 shadow-[0_1px_2px_rgba(26,26,26,0.04)] focus-within:border-accent">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={`Ask about ${selectedBook.title}…`}
            aria-label="Ask a question about this book"
            className="max-h-40 min-h-[2.25rem] flex-1 resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed outline-none placeholder:text-ink-faint"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              className="shrink-0 rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send()}
              disabled={!input.trim()}
              className="shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white hover:bg-accent-strong disabled:opacity-40"
            >
              Ask
            </button>
          )}
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-ink-faint">
          Enter sends · Shift + Enter adds a line
        </p>
      </div>
    </section>
  );
}
