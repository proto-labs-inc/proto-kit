#!/usr/bin/env node
/**
 * The proto MCP server as a stdio process, for hosts whose plugin
 * config launches a local process (Claude Code and Cursor). Bridges MCP over stdio
 * to the app's Streamable HTTP endpoint (<app>/api/mcp) over the
 * transport in mcp-call.mjs. The endpoint and bearer come from
 * ~/.proto/config.json (`app`, `auth.secret`), which setup writes.
 * Resolved on every request, so a config.json written after the host
 * started this process is picked up without a restart; the bridge
 * tells the host with notifications/tools/list_changed.
 *
 * Until it is configured, the bridge answers initialize and an empty
 * tools/list itself and refuses everything else with a plain
 * sentence, so the host shows a connected server with no tools rather
 * than a failing one. Nothing is logged to stdout but protocol
 * messages; notes go to stderr, which hosts show as the server's log.
 */
import { createInterface } from "node:readline";
import { NOT_SET_UP, post, readConfig } from "./mcp-call.mjs";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "proto-kit", version: "0" };

/** The endpoint and bearer, or null while nothing configures them. */
function resolveConfig() {
  try {
    const config = readConfig();
    return { app: config.app, secret: config.auth.secret };
  } catch {
    return null;
  }
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const note = (text) => process.stderr.write(`proto mcp: ${text}\n`);

// One upstream session per (endpoint, bearer); re-made when either
// changes or the server forgets the session.
let upstream = null; // { key, config, sessionId, ready: Promise<initResult> }
let clientInit = null; // the host's initialize params, replayed upstream

function ensureUpstream(config) {
  const key = `${config.app}\n${config.secret}`;
  if (upstream?.key === key) return upstream.ready;
  const session = { key, config, sessionId: null, ready: null };
  session.ready = (async () => {
    const init = await post(config, {
      jsonrpc: "2.0",
      id: "proto-kit-init",
      method: "initialize",
      params: {
        protocolVersion: clientInit?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: clientInit?.capabilities ?? {},
        clientInfo: clientInit?.clientInfo ?? CLIENT_INFO,
      },
    });
    if (init.status >= 400)
      throw new Error(`the Proto app answered ${init.status} to initialize`);
    const reply = init.messages.find((m) => m.id === "proto-kit-init");
    if (!reply || reply.error)
      throw new Error(reply?.error?.message ?? "no initialize result from the Proto app");
    session.sessionId = init.sessionId;
    await post(config, { jsonrpc: "2.0", method: "notifications/initialized" }, session.sessionId);
    note(`connected to ${config.app}`);
    return reply.result;
  })();
  session.ready.catch(() => {
    if (upstream === session) upstream = null; // let the next request retry
  });
  upstream = session;
  return session.ready;
}

function localInitialize(params) {
  return {
    protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: true } },
    serverInfo: { name: "proto", version: "0" },
    instructions:
      "Proto is not set up on this laptop yet. Run the Proto setup skill; its tools appear once ~/.proto/config.json exists.",
  };
}

let watcher = null;
function watchForConfig() {
  if (watcher) return;
  watcher = setInterval(() => {
    if (!resolveConfig()) return;
    clearInterval(watcher);
    watcher = null;
    note("configuration found; announcing tools");
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }, 2000);
  watcher.unref();
}

const notConfigured = (id) =>
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32002, message: NOT_SET_UP },
  });

async function forward(message) {
  const config = resolveConfig();
  let initResult;
  try {
    initResult = await ensureUpstream(config);
  } catch (err) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Proto app unreachable: ${err.message}` } });
    return;
  }
  if (message.method === "initialize") {
    const result = { ...initResult, capabilities: { ...(initResult.capabilities ?? {}) } };
    result.capabilities.tools = { ...(result.capabilities.tools ?? {}), listChanged: true };
    send({ jsonrpc: "2.0", id: message.id, result });
    return;
  }
  let res = await post(config, message, upstream.sessionId);
  if (res.status === 404 && upstream?.sessionId) {
    // The server forgot our session: make a new one and retry once.
    upstream = null;
    try {
      await ensureUpstream(config);
    } catch (err) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Proto app unreachable: ${err.message}` } });
      return;
    }
    res = await post(config, message, upstream.sessionId);
  }
  if (message.id === undefined) return; // a notification: nothing to relay
  if (res.status >= 400) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `the Proto app answered ${res.status}` } });
    return;
  }
  for (const reply of res.messages) send(reply);
}

async function handle(message) {
  if (message.method === "notifications/initialized") return; // sent upstream by ensureUpstream
  if (message.method === "initialize") clientInit = message.params ?? null;
  const configured = resolveConfig() !== null;
  if (message.id === undefined) {
    if (configured) await forward(message);
    return;
  }
  if (configured) {
    await forward(message);
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: localInitialize(message.params) });
    watchForConfig();
  } else if (message.method === "ping") send({ jsonrpc: "2.0", id: message.id, result: {} });
  else if (message.method === "tools/list") send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  else notConfigured(message.id);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  const messages = Array.isArray(message) ? message : [message];
  for (const m of messages)
    handle(m).catch((err) => {
      note(`unexpected: ${err.message}`);
      if (m.id !== undefined)
        send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: `Proto app request failed: ${err.message}` } });
    });
});
lines.on("close", () => process.exit(0));
