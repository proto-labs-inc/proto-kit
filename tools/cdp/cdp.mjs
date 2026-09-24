// Minimal CDP client over Node's built-in WebSocket. No dependencies.
export function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message));
      else p.resolve(m.result);
      return;
    }
    // messages without an id are protocol events
    const hs = listeners.get(m.method);
    if (hs) for (const h of hs) h(m.params);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, handler) => {
    if (!listeners.has(method)) listeners.set(method, new Set());
    listeners.get(method).add(handler);
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
    ws.onopen = () => resolve({ send, on, once, close: () => ws.close() });
    ws.onerror = () => reject(new Error("websocket failed: " + wsUrl));
  });
}

// Evaluate an expression in the page, return its JSON-serializable value.
// Promises are awaited. Note: return values truncate at 64KB: fetch big
// payloads in chunks.
export async function evaluate(page, expression) {
  const r = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description || "evaluate threw");
  return r.result.value;
}
