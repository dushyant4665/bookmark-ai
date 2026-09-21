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

  // Restore the last conversation for this book/edition instead of starting
  // blank — the chat survives a page refresh.
  useEffect(() => {
    const turn = ++turnRef.current;
    abortRef.current?.abort();
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
    setMessages([]);
    setConversationId(null);
    setActivity(null);
    setBusy(false);
    setRestoring(false);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  const patchAssistant = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const appendDelta = useCallback((id: string, delta: string) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, content: m.content + delta } : m))
    );
  }, []);

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

    const finish = (opts: Partial<ChatMessage> = {}) => {
      setBusy(false);
      setActivity(null);
      patchAssistant(assistantId, { streaming: false, ...opts });
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
              patchAssistant(assistantId, { evidence: readSources(data) });
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
              patchAssistant(assistantId, {
                error: data.message || 'The research backend is being prepared.',
                streaming: false,
              });
              finish();
              break;
            default:
              break;
          }
        },
        onError: () => {
          // A user-initiated Stop is an AbortError handled in the client; any
          // other end is a real failure. Never pretend generation completed.
          patchAssistant(assistantId, { error: 'Chat failed or was interrupted. Please try again.', streaming: false });
          finish();
        },
        onClose: () => {
          // Stream ended. A user Stop is honest ("Stopped."). An unexpected
          // close with no terminal event means the answer was truncated — say
          // so; never present a partial stream as a completed answer (§17).
          if (controller.signal.aborted) {
            patchAssistant(assistantId, { error: 'Stopped.', streaming: false });
          } else if (!sawTerminal) {
            patchAssistant(assistantId, {
              error: 'The connection ended before the answer finished. Please try again.',
              streaming: false,
            });
          }
          finish();
        },
      },
      controller.signal
    );
  }, [input, busy, selectedBook, selectedEdition, conversationId, patchAssistant, appendDelta]);

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
