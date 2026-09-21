import { BASE, tokenStore } from './api';
import type { ChatStreamEvent } from '../types';

// Real SSE client for POST /api/chat/stream. Reads the byte stream and parses
// `event:`/`data:` frames as they arrive. No setTimeout token simulation — if
// the backend stops, streaming stops.
export interface StreamHandlers {
  onEvent: (event: ChatStreamEvent, data: any) => void;
  onError: (error: Error) => void;
  onClose?: () => void;
}

export async function streamChat(
  body: { conversationId: string; bookId: string; editionId: string; message: string },
  handlers: StreamHandlers,
  signal: AbortSignal
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/stream`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    // A user-initiated Stop aborts the fetch; that is not a chat failure.
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      handlers.onError(err instanceof Error ? err : new Error('NETWORK_ERROR'));
    }
    return;
  }

  if (!res.ok || !res.body) {
    handlers.onError(new Error(`HTTP_${res.status}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (frame: string) => {
    let event: ChatStreamEvent | null = null;
    let data = '';
    let sawField = false;
    for (const line of frame.split('\n')) {
      // SSE comment lines (": keep-alive") carry no event — ignore them so a
      // heartbeat is never mistaken for a real (or terminal) event.
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.slice(6).trim() as ChatStreamEvent;
        sawField = true;
      } else if (line.startsWith('data:')) {
        data += line.slice(5).trim();
        sawField = true;
      }
    }
    if (!sawField) return; // pure heartbeat / empty frame
    const type: ChatStreamEvent = event ?? 'message';
    try {
      handlers.onEvent(type, JSON.parse(data));
    } catch {
      handlers.onEvent(type, data);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (frame.trim()) dispatch(frame);
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === 'AbortError')) {
      handlers.onError(err instanceof Error ? err : new Error('STREAM_ERROR'));
    }
  } finally {
    handlers.onClose?.();
  }
}
