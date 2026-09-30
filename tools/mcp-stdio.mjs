#!/usr/bin/env node
/**
 * The proto MCP server as a stdio process, for hosts whose plugin
 * config launches a local process (Claude Code and Cursor). Bridges MCP over stdio
 * to the app's Streamable HTTP endpoint (<app>/api/mcp) over the
 * transport in mcp-call.mjs. The endpoint and the credentials come
 * from ~/.proto/config.json, which setup writes, and are resolved on
 * every request, so a config.json written after the host started this
 * process is picked up without a restart; the bridge tells the host
 * with notifications/tools/list_changed.
 *
 * A laptop holds one credential per team (MAA-195), so the bearer is
 * chosen per call from the codebase the call names, not once for the
 * connection: one host session reaches every team this laptop is
 * linked to, and an upstream session is kept per credential.
 *
 * Until it is configured, the bridge answers initialize and an empty
 * tools/list itself and refuses everything else with a plain
 * sentence, so the host shows a connected server with no tools rather
 * than a failing one. Nothing is logged to stdout but protocol
 * messages; notes go to stderr, which hosts show as the server's log.
 */
import { createInterface } from "node:readline";
import { NOT_SET_UP, actingAs, pickCredential, post, readConfig, rememberCodebaseTeam } from "./mcp-call.mjs";

const PROTOCOL_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "proto-kit", version: "0" };

/** What this laptop holds, or null while nothing configures it. */
function resolveConfig() {
  try {
    return readConfig();
  } catch {
    return null;
  }
}

/** The codebase a message acts on, when it names one. */
function codebaseOf(message) {
  return message.method === "tools/call" ? message.params?.arguments?.codebase : undefined;
}

const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const note = (text) => process.stderr.write(`proto mcp: ${text}\n`);

// One upstream session per (endpoint, bearer), kept side by side: a
// laptop linked to several teams talks to the same app as a different
// member on each. Re-made when the server forgets a session.
const upstreams = new Map(); // key -> { key, target, sessionId, ready: Promise<initResult> }
let clientInit = null; // the host's initialize params, replayed upstream

const keyOf = (target) => `${target.app}\n${target.secret}`;

function ensureUpstream(target) {
  const key = keyOf(target);
  const existing = upstreams.get(key);
  if (existing) return existing.ready;
  const session = { key, target, sessionId: null, ready: null };
  session.ready = (async () => {
    const init = await post(target, {
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
    await post(target, { jsonrpc: "2.0", method: "notifications/initialized" }, session.sessionId);
    note(`connected to ${target.app}`);
    return reply.result;
  })();
  session.ready.catch(() => {
    if (upstreams.get(key) === session) upstreams.delete(key); // let the next request retry
  });
  upstreams.set(key, session);
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
  const codebase = codebaseOf(message);
  let credential;
  try {
    const pick = pickCredential(config, { codebase });
    credential = pick.credential;
    if (pick.why === "newest") note(actingAs(codebase, credential).replace(/^proto: /, ""));
  } catch (err) {
    // No credential for this codebase's team: the sentence says which
    // team to link from, and the connection stays up for the others.
    if (message.id !== undefined)
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: err.message } });
    return;
  }
  const target = { app: config.app, secret: credential.secret };
  let initResult;
  try {
    initResult = await ensureUpstream(target);
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
  let session = upstreams.get(keyOf(target));
  let res = await post(target, message, session?.sessionId);
  if (res.status === 404 && session?.sessionId) {
    // The server forgot our session: make a new one and retry once.
    upstreams.delete(keyOf(target));
    try {
      await ensureUpstream(target);
    } catch (err) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `Proto app unreachable: ${err.message}` } });
      return;
    }
    session = upstreams.get(keyOf(target));
    res = await post(target, message, session?.sessionId);
  }
  if (message.id === undefined) return; // a notification: nothing to relay
  if (res.status >= 400) {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `the Proto app answered ${res.status}` } });
    return;
  }
  // A call the server accepted proves this credential's team owns the
  // codebase, which is how a codebase from an older kit learns its team.
  const answer = res.messages.find((m) => m.id === message.id);
  if (codebase && credential.team && answer?.result && answer.result.isError !== true)
    rememberCodebaseTeam(codebase, credential.team);
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
