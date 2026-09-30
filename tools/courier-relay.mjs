/**
 * The courier's transport: one WebSocket the courier holds open to the
 * site's relay (docs/research/2026-09-29-command-relay.md in the proto
 * repo). Each command the relay sends goes to courier.mjs's handle(), and
 * is answered with a reply once it is in the feed. Whether a session is
 * listening is reported on connect and whenever it changes.
 *
 * The heartbeat lives here now, on the connection: a ping every
 * PING_EVERY_MS, which the relay answers without waking. A laptop that
 * sleeps sends nothing and closes nothing, so both ends judge the other by
 * silence: the relay counts this courier gone after DEAD_AFTER_MS without
 * a ping, and this courier drops the socket after DEAD_AFTER_MS without a
 * pong, then reconnects, backing off from one second to thirty.
 * Outbound on 443 only, so a network that blocks tunnels does not matter.
 *
 * Shapes and numbers are packages/relay/src/protocol.ts's; change both
 * together.
 */

export const PING_EVERY_MS = 10_000;
export const DEAD_AFTER_MS = 30_000;
const LISTENING_CHECK_MS = 2_000;

/** One second doubling to thirty, with plus or minus a quarter of jitter. */
export function nextDelay(attempt, random = Math.random) {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.75 + random() * 0.5));
}

/** The relay settings in courier.json, or null when this courier has none yet. */
export function relayConfig(courierJson) {
  const relay = courierJson?.relay;
  if (typeof relay?.url !== "string" || typeof relay?.token !== "string") return null;
  return { url: relay.url, token: relay.token };
}

export function connectRelay({
  url,
  courierId,
  token,
  handle,
  listening,
  log,
  WebSocketImpl = globalThis.WebSocket,
  delay = nextDelay,
  now = Date.now,
  every = (fn, ms) => setInterval(fn, ms),
  stopEvery = (id) => clearInterval(id),
}) {
  const address = `${url.replace(/^http/, "ws").replace(/\/+$/, "")}/couriers/${courierId}/connect?token=${encodeURIComponent(token)}`;
  let state = "connecting";
  let socket = null;
  let attempt = 0;
  let stopped = false;
  let lastListening = null;
  let lastPong = 0;
  let timers = [];

  const send = (message) => {
    try {
      socket?.send(typeof message === "string" ? message : JSON.stringify(message));
    } catch {}
  };
  const reportListening = () => {
    const current = Boolean(listening());
    if (current === lastListening) return;
    lastListening = current;
    send({ type: "state", agentListening: current });
  };
  const keepAlive = () => {
    if (now() - lastPong > DEAD_AFTER_MS) {
      log("relay: no pong, dropping the connection");
      socket?.close();
      return;
    }
    send("ping");
  };
  // One command at a time, in the order they arrive.
  let queue = Promise.resolve();
  const onCommand = (message) => {
    queue = queue.then(async () => {
      log(`relay: command ${message.id}`);
      try {
        const { status } = await handle(message.command);
        if (status >= 200 && status < 300) send({ type: "reply", id: message.id });
      } catch (error) {
        // No reply, so the site sees no-reply; the commands behind it still run.
        log(`relay: command ${message.id} failed: ${error?.message ?? error}`);
      }
    });
  };

  const open = () => {
    state = "connecting";
    socket = new WebSocketImpl(address);
    socket.addEventListener("open", () => {
      state = "connected";
      attempt = 0;
      lastListening = null;
      lastPong = now();
      log("relay: connected");
      reportListening();
      timers.push(every(keepAlive, PING_EVERY_MS));
      timers.push(every(reportListening, LISTENING_CHECK_MS));
    });
    socket.addEventListener("message", (event) => {
      const data = String(event.data);
      if (data === "pong") {
        lastPong = now();
        return;
      }
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message?.type === "command" && typeof message.id === "string") onCommand(message);
    });
    socket.addEventListener("close", (event) => {
      for (const id of timers) stopEvery(id);
      timers = [];
      if (stopped) return;
      state = "waiting";
      const wait = delay(attempt);
      attempt += 1;
      log(`relay: disconnected (${event?.code ?? "?"}), reconnecting in ${Math.round(wait / 1000)}s`);
      setTimeout(() => !stopped && open(), wait);
    });
    socket.addEventListener("error", () => {
      // A close always follows an error; the close reconnects.
    });
  };

  open();
  return {
    state: () => state,
    close() {
      stopped = true;
      for (const id of timers) stopEvery(id);
      timers = [];
      try {
        socket?.close();
      } catch {}
    },
  };
}
