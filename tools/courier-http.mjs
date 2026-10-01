/**
 * The courier's local HTTP port (MAA-130). Carries bearer-authed JSON
 * commands from this laptop to the transport-agnostic handler in
 * courier.mjs. GET /health is the read-only check used by courier-up.mjs:
 * it never reaches the command handler or appends to the feed. It listens on
 * 127.0.0.1 only; the site's commands arrive through the relay
 * (courier-relay.mjs).
 */
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const MAX_BODY = 64 * 1024;

function authorized(req, secret) {
  const header = req.headers.authorization ?? "";
  const expected = `Bearer ${secret}`;
  if (header.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(expected));
}

export function serveHttp({ port, secret, handle, health }, onReady) {
  const server = createServer(async (req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!authorized(req, secret)) return respond(401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/health") return respond(200, await health());
    if (req.method !== "POST") return respond(405, { error: "POST or GET /health only" });

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) req.destroy();
    });
    req.on("end", async () => {
      let cmd;
      try {
        cmd = JSON.parse(raw);
      } catch {
        return respond(400, { error: "invalid JSON" });
      }
      const { status, body } = await handle(cmd);
      respond(status, body);
    });
  });
  server.listen(port, "127.0.0.1", () => onReady?.(server));
  return server;
}
