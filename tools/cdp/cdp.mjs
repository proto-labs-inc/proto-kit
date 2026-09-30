// Minimal CDP client over Node's built-in WebSocket. No dependencies.
//
// Every command is bounded: a reply that does not come within
// `timeoutMs` rejects, and a connection that closes rejects everything
// still pending. A tab whose renderer is gone, or a Chrome that was
// stopped under a lane, used to leave the caller waiting forever (a
// build sat twenty minutes on seven such lanes); now the lane fails
// with the command's name and moves on.

// Long enough for a screenshot of a large page or an evaluate that
// waits fifteen seconds in the page; nothing legitimate takes longer.
export const COMMAND_TIMEOUT_MS = 30_000;

export function connect(wsUrl, { openTimeoutMs = 10_000 } = {}) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  let closed = null;
  const failPending = (reason) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    pending.clear();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    // messages without an id are protocol events
    const hs = listeners.get(m.method);
    if (hs) for (const h of hs) h(m.params);
  };
  ws.onclose = () => {
    closed = "the CDP connection closed under a pending command (the tab or its Chrome is gone)";
    failPending(closed);
  };
  const send = (method, params = {}, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error(`${method}: ${closed}`));
        return;
      }
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs / 1000} s`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
    return () => listeners.get(method)?.delete(handler);
  };
  // resolves on the next occurrence of the event
  const once = (method) =>
    new Promise((resolve) => {
      const h = (params) => {
        listeners.get(method).delete(h);
        resolve(params);
      };
      on(method, h);
    });
  return new Promise((resolve, reject) => {
    const opening = setTimeout(() => {
      ws.close();
      reject(new Error(`websocket did not open within ${openTimeoutMs / 1000} s: ${wsUrl}`));
    }, openTimeoutMs);
    opening.unref?.();
    ws.onopen = () => {
      clearTimeout(opening);
      resolve({ send, on, once, close: () => ws.close() });
    };
    ws.onerror = () => {
      clearTimeout(opening);
      // An error after the open closes the socket; onclose fails what is pending.
      reject(new Error("websocket failed: " + wsUrl));
    };
  });
}

// Evaluate an expression in the page, return its JSON-serializable value.
// Promises are awaited. Note: return values truncate at 64KB: fetch big
// payloads in chunks. `timeoutMs` bounds the wait for the page's answer.
export async function evaluate(page, expression, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, { timeoutMs });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description || "evaluate threw");
  return r.result.value;
}
