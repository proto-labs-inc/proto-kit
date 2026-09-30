import { test } from "node:test";
import assert from "node:assert/strict";
import { connectRelay, nextDelay, relayConfig, NEEDS_NODE_22, PING_EVERY_MS, DEAD_AFTER_MS } from "./courier-relay.mjs";

class FakeSocket {
  static made = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = {};
    this.closed = false;
    FakeSocket.made.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type, event = {}) {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  send(text) {
    this.sent.push(text);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", { code: 1000 });
  }
}
const quiet = () => {};
const tick = () => new Promise((r) => setTimeout(r, 5));
const base = (overrides = {}) => ({
  url: "https://relay.example",
  courierId: "abc",
  token: "abc.sig",
  handle: async () => ({ status: 202 }),
  listening: () => false,
  log: quiet,
  WebSocketImpl: FakeSocket,
  delay: () => 1,
  ...overrides,
});

test("the courier pings three times inside the window that declares it gone", () => {
  assert.equal(DEAD_AFTER_MS, 3 * PING_EVERY_MS);
});

test("backoff doubles from one second to thirty, with jitter", () => {
  const middle = () => 0.5;
  assert.equal(nextDelay(0, middle), 1000);
  assert.equal(nextDelay(1, middle), 2000);
  assert.equal(nextDelay(10, middle), 30000);
  assert.ok(nextDelay(0, () => 0) >= 750 && nextDelay(0, () => 1) <= 1250);
});

test("relay settings come from courier.json, or nothing", () => {
  assert.deepEqual(relayConfig({ relay: { url: "https://r", token: "t" } }), { url: "https://r", token: "t" });
  assert.equal(relayConfig({}), null);
  assert.equal(relayConfig({ relay: { url: "https://r" } }), null);
});

test("connects with its token, says whether it listens, and replies to a command once handled", async () => {
  FakeSocket.made = [];
  const handled = [];
  const line = connectRelay(base({ listening: () => true, handle: async (c) => (handled.push(c), { status: 202 }) }));
  const socket = FakeSocket.made[0];
  assert.equal(socket.url, "wss://relay.example/couriers/abc/connect?token=abc.sig");
  socket.emit("open");
  assert.equal(line.state(), "connected");
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: "state", agentListening: true });
  socket.emit("message", { data: JSON.stringify({ type: "command", id: "c1", command: { run: "create-prototype" } }) });
  await tick();
  assert.deepEqual(handled, [{ run: "create-prototype" }]);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "reply", id: "c1" });
  line.close();
});

test("a command the courier refuses gets no reply", async () => {
  FakeSocket.made = [];
  const line = connectRelay(base({ handle: async () => ({ status: 400 }) }));
  const socket = FakeSocket.made[0];
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ type: "command", id: "c1", command: {} }) });
  await tick();
  assert.equal(socket.sent.filter((s) => s.includes('"reply"')).length, 0);
  line.close();
});

test("a closed socket reconnects", async () => {
  FakeSocket.made = [];
  const line = connectRelay(base());
  FakeSocket.made[0].emit("open");
  FakeSocket.made[0].emit("close", { code: 1006 });
  assert.equal(line.state(), "waiting");
  await tick();
  assert.equal(FakeSocket.made.length, 2);
  line.close();
});

test("pings on schedule, and drops a socket whose pings go unanswered", async () => {
  FakeSocket.made = [];
  let clock = 0;
  const timers = [];
  const line = connectRelay(
    base({
      now: () => clock,
      every: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      stopEvery: () => {},
    }),
  );
  const socket = FakeSocket.made[0];
  socket.emit("open");
  const ping = timers.find((t) => t.ms === PING_EVERY_MS);
  clock += PING_EVERY_MS;
  ping.fn();
  assert.equal(socket.sent.at(-1), "ping");
  socket.emit("message", { data: "pong" });
  clock += DEAD_AFTER_MS - 1;
  ping.fn();
  assert.equal(socket.closed, false);
  clock += 2;
  ping.fn();
  assert.equal(socket.closed, true);
  line.close();
});

test("garbage from the relay is ignored", async () => {
  FakeSocket.made = [];
  const line = connectRelay(base({ handle: async () => assert.fail("nothing should be handled") }));
  const socket = FakeSocket.made[0];
  socket.emit("open");
  for (const data of ["pong", "not json", "{}", JSON.stringify({ type: "command", command: {} })]) socket.emit("message", { data });
  await tick();
  line.close();
});

test("a command whose handling throws does not stop the ones after it", async () => {
  FakeSocket.made = [];
  const handled = [];
  const line = connectRelay(
    base({
      handle: async (c) => {
        handled.push(c.n);
        if (c.n === 1) throw new Error("boom");
        return { status: 202 };
      },
    }),
  );
  const socket = FakeSocket.made[0];
  socket.emit("open");
  socket.emit("message", { data: JSON.stringify({ type: "command", id: "c1", command: { n: 1 } }) });
  socket.emit("message", { data: JSON.stringify({ type: "command", id: "c2", command: { n: 2 } }) });
  await tick();
  assert.deepEqual(handled, [1, 2]);
  assert.deepEqual(JSON.parse(socket.sent.at(-1)), { type: "reply", id: "c2" });
  line.close();
});

class SilentCloseSocket extends FakeSocket {
  // A black-holed path: close() only starts the closing handshake, and no close event comes.
  close() {
    this.closed = true;
  }
}

test("a dead socket is replaced at once, and its late close starts no second reconnect", async () => {
  FakeSocket.made = [];
  let clock = 0;
  const timers = [];
  const line = connectRelay(
    base({
      WebSocketImpl: SilentCloseSocket,
      now: () => clock,
      every: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      stopEvery: () => {},
    }),
  );
  const first = FakeSocket.made[0];
  first.emit("open");
  const ping = timers.find((t) => t.ms === PING_EVERY_MS);
  clock += DEAD_AFTER_MS + 1;
  ping.fn();
  assert.equal(first.closed, true);
  assert.equal(line.state(), "waiting");
  await tick();
  assert.equal(FakeSocket.made.length, 2);
  first.emit("close", { code: 1006 });
  first.emit("message", { data: JSON.stringify({ type: "command", id: "late", command: {} }) });
  await tick();
  assert.equal(FakeSocket.made.length, 2);
  line.close();
});

test("a relay address the WebSocket refuses is retried with backoff, not thrown", async () => {
  FakeSocket.made = [];
  let calls = 0;
  class RefusingOnce extends FakeSocket {
    constructor(url) {
      calls += 1;
      if (calls === 1) throw new SyntaxError("Invalid URL");
      super(url);
    }
  }
  const line = connectRelay(base({ WebSocketImpl: RefusingOnce }));
  assert.equal(line.state(), "waiting");
  await tick();
  assert.equal(FakeSocket.made.length, 1);
  line.close();
});

test("a reply goes only on the socket its command came in on", async () => {
  FakeSocket.made = [];
  let finish;
  const line = connectRelay(base({ handle: () => new Promise((r) => (finish = r)) }));
  const first = FakeSocket.made[0];
  first.emit("open");
  first.emit("message", { data: JSON.stringify({ type: "command", id: "c1", command: {} }) });
  await tick();
  first.emit("close", { code: 1006 });
  await tick();
  const second = FakeSocket.made[1];
  second.emit("open");
  finish({ status: 202 });
  await tick();
  const replies = (socket) => socket.sent.filter((s) => s.includes('"reply"')).length;
  assert.equal(replies(first), 0);
  assert.equal(replies(second), 0);
  line.close();
});

test("a Node without WebSocket says so once and does not retry", async () => {
  const lines = [];
  let delays = 0;
  const line = connectRelay(base({ WebSocketImpl: null, log: (text) => lines.push(text), delay: () => (delays++, 1) }));
  await tick();
  assert.equal(line.state(), "unsupported");
  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith(`relay: ${NEEDS_NODE_22}; this is Node `));
  assert.equal(delays, 0);
  line.close();
});
