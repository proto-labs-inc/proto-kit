/**
 * Minimal MCP-over-HTTP client for the kit's plain node processes
 * (the courier's heartbeat, publish, the prototype heartbeat; agents
 * use their harness's MCP instead) and the transport under
 * mcp-stdio.mjs, the Cursor plugin's stdio bridge. Speaks just enough
 * Streamable HTTP: POST one JSON-RPC message, carry the session header
 * when the server issues one, read answers that come as plain JSON or
 * as SSE frames. `readConfig` is the one reader of
 * ~/.proto/config.json for every kit process; `callTool` takes the
 * endpoint and the laptop token from it (`app`, `auth.secret`) and sends
 * the token as the bearer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_PATH = join(process.env.HOME ?? "", ".proto", "config.json");
export const NOT_SET_UP =
  "Proto is not set up on this laptop yet: run the Proto setup skill, then try again.";
export const STALE_CREDENTIAL =
  "This laptop's Proto credential no longer works (it was removed on the Laptops page, or the account left the org): run the Proto setup skill again to link it afresh.";

function configTarget() {
  const config = readConfig();
  return { app: config.app, secret: config.auth.secret };
}

/**
 * ~/.proto/config.json, the account link setup writes (shape in
 * skills/setup). A file that is missing, unreadable, or without the
 * app origin and the secret throws NOT_SET_UP, so every kit process
 * answers "not set up yet" with the same sentence. `app` comes back
 * without a trailing slash.
 */
export function readConfig() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    throw new Error(NOT_SET_UP);
  }
  const app = typeof config.app === "string" ? config.app.trim() : "";
  const secret = config.auth?.secret;
  if (
    config.schemaVersion !== 2 ||
    config.auth?.kind !== "laptop-token" ||
    app.length === 0 ||
    typeof secret !== "string" ||
    secret.length === 0
  ) {
    throw new Error(NOT_SET_UP);
  }
  return { ...config, app: app.replace(/\/+$/, "") };
}

/** Every JSON-RPC message in a response body: plain JSON or SSE frames. */
export function parseMessages(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const messages = [];
  for (const frame of trimmed.split(/\n\n+/)) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (data.length === 0) continue;
    const parsed = JSON.parse(data);
    if (Array.isArray(parsed)) messages.push(...parsed);
    else messages.push(parsed);
  }
  return messages;
}

/**
 * POST one JSON-RPC message to the app's MCP endpoint. Returns the
 * HTTP status, the session id the server issued (if any), and the
 * parsed messages of a successful answer (empty for 202 or errors).
 * `secret` is the laptop token, sent as the bearer; null sends none,
 * which only link_laptop accepts.
 */
export async function post({ app, secret }, body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (secret) headers.Authorization = `Bearer ${secret}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(`${app}/api/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    sessionId: res.headers.get("mcp-session-id"),
    messages: res.ok ? parseMessages(text) : [],
    text,
  };
}

/** Call one tool as this laptop (the target from config.json), or, with
 *  an explicit target, as whoever that says: link_laptop is called with
 *  { app, secret: null } before config.json exists. Throws on a JSON-RPC
 *  error and on 401, with the sentence the setup skill tells the user. */
export async function callTool(name, args, target = configTarget()) {
  const init = await post(target, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "proto-kit", version: "0" },
    },
  });

  const res = await post(
    target,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
    init.sessionId,
  );
  if (res.status === 401) throw new Error(STALE_CREDENTIAL);
  const body = res.messages.find((m) => m.id === 2) ?? res.messages[0];
  if (!body) throw new Error(`${name}: the Proto app answered ${res.status}`);
  if (body.error) throw new Error(`${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}
