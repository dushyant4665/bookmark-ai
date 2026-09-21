import type { ReactNode } from 'react';
import type { ChatMessage, Evidence } from '../types';
import { SourceCard } from './SourceCard';
import { Spinner } from './ui';

// The typing caret travels inside the text itself (as an invisible marker), so
// it lands at the end of the last line instead of on a line of its own.
const CARET_MARK = '⁣';

function inlineRuns(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const body = token.slice(2, -2);
    out.push(token.startsWith('**')
      ? <strong key={`${keyBase}-s${m.index}`} className="font-semibold">{body}</strong>
      : <em key={`${keyBase}-i${m.index}`}>{token.slice(1, -1)}</em>);
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// Inline **bold** / *italic* without any HTML injection: the text is split into
// React nodes, so model output can never become markup.
function renderInline(text: string, keyBase: string): ReactNode[] {
  const chunks = text.split(CARET_MARK);
  return chunks.flatMap((chunk, i) => [
    ...inlineRuns(chunk, `${keyBase}-${i}`),
    ...(i < chunks.length - 1 ? [<span key={`${keyBase}-caret`} className="bm-caret" aria-hidden />] : []),
  ]);
}

// Minimal, safe block renderer (paragraphs, headings, bullet + numbered lists,
// quotes). We intentionally avoid dangerouslySetInnerHTML — AI text is never
// injected as HTML.
function renderBlocks(text: string) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let ordered = false;

  const flushList = (key: number) => {
    if (!list.length) return;
    const items = list.map((item, i) => <li key={i}>{renderInline(item, `${key}-${i}`)}</li>);
    blocks.push(ordered ? (
      <ol key={`ol-${key}`} className="my-2 list-decimal space-y-1 pl-5">{items}</ol>
    ) : (
      <ul key={`ul-${key}`} className="my-2 list-disc space-y-1 pl-5">{items}</ul>
    ));
    list = [];
  };

  const bullet = /^(?:[-*•]\s+(.+))$/;
  const numbered = /^\d+[.)]\s+(.+)$/;

  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const ul = bullet.exec(line);
    const ol = numbered.exec(line);
    if (ul || ol) {
      const wantsOrdered = Boolean(ol);
      if (list.length && wantsOrdered !== ordered) flushList(i);
      ordered = wantsOrdered;
      list.push((ul?.[1] ?? ol?.[1] ?? '').trim());
      return;
    }
    flushList(i);
    if (!line.trim()) return;
    if (line.startsWith('## ')) blocks.push(<h3 key={i} className="mt-3 font-serif text-base font-semibold">{line.slice(3)}</h3>);
    else if (line.startsWith('# ')) blocks.push(<h2 key={i} className="mt-3 font-serif text-lg font-semibold">{line.slice(2)}</h2>);
    else if (line.startsWith('> ')) blocks.push(<blockquote key={i} className="my-2 border-l-2 border-line pl-3 italic text-ink-muted">{renderInline(line.slice(2), `q-${i}`)}</blockquote>);
    else blocks.push(<p key={i} className="my-2 leading-relaxed first:mt-0 last:mb-0">{renderInline(line, `p-${i}`)}</p>);
  });
  flushList(blocks.length);
  return blocks;
}

export function Message({ message, onOpenSource }: { message: ChatMessage; onOpenSource?: (e: Evidence) => void }) {
  if (message.role === 'user') {
    return (
      <div className="bm-rise flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-md bg-accent px-4 py-2.5 text-sm leading-relaxed text-white">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <article className="bm-rise text-sm text-ink">
      {message.content ? (
        <div className="rounded-xl border border-line bg-surface px-4 py-3 shadow-[0_1px_0_rgba(26,26,26,0.03)]">
          <div className="font-serif text-[15px] leading-relaxed">
            {renderBlocks(message.content + (message.streaming ? CARET_MARK : ''))}
          </div>
        </div>
      ) : null}
      {message.streaming && !message.content ? <Spinner label="Searching the book…" /> : null}
      {message.error ? (
        <p
          className={`mt-2 rounded-md border px-3 py-2 text-sm ${
            message.error === 'Stopped.'
              ? 'border-line bg-surface-sunken text-ink-muted'
              : 'border-red-200 bg-red-50 text-red-800'
          }`}
          role="alert"
        >
          {message.error}
        </p>
      ) : null}
      {message.evidence && message.evidence.length > 0 ? (
        <div className="mt-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Sources
            <span className="h-px flex-1 bg-line" aria-hidden />
          </div>
          {message.evidence.map((e) => (
            <SourceCard key={e.id} evidence={e} onOpen={onOpenSource} />
          ))}
        </div>
      ) : null}
    </article>
  );
}
