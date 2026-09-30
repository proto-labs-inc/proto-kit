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
 *
 * The WebSocket is Node's own, which Node 22 is the first to ship. On an
 * older Node the courier says so once and stays "unsupported" instead of
 * retrying a connection it can never make.
 */

export const PING_EVERY_MS = 10_000;
export const DEAD_AFTER_MS = 30_000;
const LISTENING_CHECK_MS = 2_000;
export const NEEDS_NODE_22 = "Proto's courier needs Node 22 or newer for WebSocket";

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
  if (typeof WebSocketImpl !== "function") {
    log(`relay: ${NEEDS_NODE_22}; this is Node ${process.versions.node}, so the site's commands cannot reach this laptop until the courier runs on a newer one`);
    return { state: () => "unsupported", close() {} };
  }
  const address = `${url.replace(/^http/, "ws").replace(/\/+$/, "")}/couriers/${courierId}/connect?token=${encodeURIComponent(token)}`;
  let state = "connecting";
  let socket = null;
  let attempt = 0;
  let stopped = false;
  let lastListening = null;
  let lastPong = 0;
  let timers = [];

  const sendOn = (target, message) => {
    try {
      target?.send(typeof message === "string" ? message : JSON.stringify(message));
    } catch {}
  };
  const send = (message) => sendOn(socket, message);
  const stopTimers = () => {
    for (const id of timers) stopEvery(id);
    timers = [];
  };
  const reportListening = () => {
    const current = Boolean(listening());
    if (current === lastListening) return;
    lastListening = current;
    send({ type: "state", agentListening: current });
  };
  // One command at a time, in the order they arrive. A reply goes back only
  // on the socket the command came in on; if that socket has been replaced,
  // the reply is dropped and the site sees no-reply.
  let queue = Promise.resolve();
  const onCommand = (from, message) => {
    queue = queue.then(async () => {
      log(`relay: command ${message.id}`);
      try {
        const { status } = await handle(message.command);
        if (status < 200 || status >= 300) return;
        if (from !== socket) {
          log(`relay: command ${message.id} handled after its connection was replaced, no reply`);
          return;
        }
        sendOn(from, { type: "reply", id: message.id });
      } catch (error) {
        // No reply, so the site sees no-reply; the commands behind it still run.
        log(`relay: command ${message.id} failed: ${error?.message ?? error}`);
      }
    });
  };

  // Every way a connection ends comes here once: a close event from the
  // current socket, no pong in time, or a socket that could not be made.
  const reconnect = (reason) => {
    stopTimers();
    socket = null;
    if (stopped) return;
    state = "waiting";
    const wait = delay(attempt);
    attempt += 1;
    log(`relay: disconnected (${reason}), reconnecting in ${Math.round(wait / 1000)}s`);
    setTimeout(() => {
      if (!stopped) open();
    }, wait);
  };
  // A dead socket's close() only starts the closing handshake; on a path
  // that went dark (a laptop that slept, a NAT entry that expired) its close
  // event can take minutes. So the courier lets it go and reconnects now;
  // anything the old socket says later is ignored.
  const keepAlive = () => {
    if (now() - lastPong > DEAD_AFTER_MS) {
      const dead = socket;
      reconnect("no pong");
      try {
        dead?.close();
      } catch {}
      return;
    }
    send("ping");
  };

  const open = () => {
    state = "connecting";
    let current;
    try {
      current = new WebSocketImpl(address);
    } catch (error) {
      reconnect(`cannot connect: ${error?.message ?? error}`);
      return;
    }
    socket = current;
    current.addEventListener("open", () => {
      if (current !== socket) return;
      state = "connected";
      attempt = 0;
      lastListening = null;
      lastPong = now();
      log("relay: connected");
      reportListening();
      timers.push(every(keepAlive, PING_EVERY_MS));
      timers.push(every(reportListening, LISTENING_CHECK_MS));
    });
    current.addEventListener("message", (event) => {
      if (current !== socket) return;
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
      if (message?.type === "command" && typeof message.id === "string") onCommand(current, message);
    });
    current.addEventListener("close", (event) => {
      if (current !== socket) return;
      reconnect(event?.code ?? "?");
    });
    current.addEventListener("error", () => {
      // A close always follows an error; the close reconnects.
    });
  };

  open();
  return {
    state: () => state,
    close() {
      stopped = true;
      stopTimers();
      try {
        socket?.close();
      } catch {}
    },
  };
}
