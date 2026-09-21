import { env } from '../config/env.js';

// Groq service abstraction (OpenAI-compatible chat API). Owns model config.
// Not wired into answering in Phase 1 — the RAG pipeline arrives later.

export function groqConfigured() {
  return Boolean(env.groqApiKey && env.groqModel);
}

// Returns a raw fetch Response whose body is a streaming SSE reader, so the
// chat route can forward real tokens as they arrive. Never fabricates output.
// An optional AbortSignal lets the server stop pulling from Groq the moment the
// browser disconnects, so generation cost does not run on after the user left.
export async function streamChatCompletion(messages, { signal } = {}) {
  if (!groqConfigured()) {
    throw new Error('GROQ_NOT_CONFIGURED');
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.groqApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: env.groqModel, messages, stream: true }),
    signal,
  });
  if (!res.ok) {
    throw new Error(`GROQ_ERROR_${res.status}`);
  }
  return res;
}

// Async generator over the ACTUAL generated text deltas. Parses the OpenAI-
// style SSE frames Groq emits and yields each `choices[0].delta.content` string
// as it arrives — the answer stream is whatever the model really produced, never
// a simulated chunking. Aborts the upstream fetch when the consumer stops early.
export async function* streamChatContent(messages, { signal } = {}) {
  const res = await streamChatCompletion(messages, { signal });
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') return;
          let obj;
          try {
            obj = JSON.parse(payload);
          } catch {
            continue;
          }
          const delta = obj?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length) yield delta;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// Phase 3: non-streaming completion for the grounded RAG answer, which must be
// a single structured JSON object (answer + evidenceIds + confidence). Reuses
// the same client/base/key — there is deliberately only ONE Groq client.
export async function completeChat(messages, { json = true, temperature = 0.2 } = {}) {
  if (!groqConfigured()) {
    throw new Error('GROQ_NOT_CONFIGURED');
  }
  const body = { model: env.groqModel, messages, temperature, stream: false };
  if (json) body.response_format = { type: 'json_object' };
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.groqApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GROQ_ERROR_${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('GROQ_MALFORMED_RESPONSE');
  }
  return content;
}
