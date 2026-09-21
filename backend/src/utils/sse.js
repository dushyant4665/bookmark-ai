// Server-Sent Events helper. Sets headers and exposes emit(event, data).
//
// A real periodic keep-alive comment is sent so idle proxies (Render, CDNs)
// don't buffer or drop a long-running stream that's waiting on the model. It is
// an SSE comment line (": …"), not a fabricated application event, and it stops
// the instant the response closes.
export function startSse(res, { heartbeatMs = 15000 } = {}) {
  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // Flush an initial comment so the client's reader gets bytes immediately.
  res.write(': open\n\n');

  let timer = null;
  if (heartbeatMs > 0) {
    timer = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, heartbeatMs);
    timer.unref?.();
  }
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  res.on('close', stop);
  res.on('finish', stop);

  return function emit(event, data = {}) {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}
