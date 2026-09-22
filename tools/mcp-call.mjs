/**
 * Minimal MCP-over-HTTP client for the kit's plain node processes
 * (the courier's heartbeat, publish, the prototype heartbeat; agents
 * use their harness's MCP instead) and the transport under
 * mcp-stdio.mjs, the Cursor plugin's stdio bridge. Speaks just enough
 * Streamable HTTP: POST one JSON-RPC message, carry the session header
 * when the server issues one, read answers that come as plain JSON or
 * as SSE frames. `callTool` reads the endpoint and bearer from
 * ~/.proto/config.json (`app`, `auth.secret`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
 */
export async function post({ app, secret }, body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${secret}`,
  };
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

export async function callTool(name, args) {
  const config = JSON.parse(
    readFileSync(join(process.env.HOME ?? "", ".proto", "config.json"), "utf8"),
  );
  const target = { app: config.app, secret: config.auth.secret };

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
  const body = res.messages.find((m) => m.id === 2) ?? res.messages[0];
  if (!body) throw new Error(`${name}: the Proto app answered ${res.status}`);
  if (body.error) throw new Error(`${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}
