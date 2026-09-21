/**
 * Minimal MCP-over-HTTP client for the kit's plain node processes
 * (the courier's heartbeat — agents use their harness's MCP instead).
 * Speaks just enough Streamable HTTP: initialize, then tools/call,
 * carrying the session header when the server issues one; answers may
 * be plain JSON or SSE-framed. Reads the endpoint + bearer from
 * ~/.proto/config.json (`app`, `auth.secret`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function parseBody(text) {
  // SSE frames wrap the JSON in "data:" lines; plain JSON comes as-is.
  const data = text.startsWith("event:") || text.includes("\ndata:") || text.startsWith("data:")
    ? text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("")
    : text;
  return JSON.parse(data);
}

export async function callTool(name, args) {
  const config = JSON.parse(
    readFileSync(join(process.env.HOME ?? "", ".proto", "config.json"), "utf8"),
  );
  const url = `${config.app}/api/mcp`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${config.auth.secret}`,
  };

  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "proto-kit", version: "0" },
      },
    }),
  });
  const session = init.headers.get("mcp-session-id");
  if (session) headers["Mcp-Session-Id"] = session;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const body = parseBody(await res.text());
  if (body.error) throw new Error(`${name}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}
