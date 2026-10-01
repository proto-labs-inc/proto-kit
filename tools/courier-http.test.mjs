import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { serveHttp } from "./courier-http.mjs";

const secret = "test-secret";

async function listeningServer(options) {
  const server = serveHttp({ port: 0, secret, ...options });
  await once(server, "listening");
  const { port } = server.address();
  return { server, origin: `http://127.0.0.1:${port}` };
}

test("GET /health reads health without handling or queueing a command", async (t) => {
  let handled = 0;
  const { server, origin } = await listeningServer({
    handle: async () => {
      handled += 1;
      return { status: 202, body: { ok: true } };
    },
    health: async () => ({ ok: true, relay: "connected", agentListening: true }),
  });
  t.after(() => server.close());

  const response = await fetch(`${origin}/health`, {
    headers: { authorization: `Bearer ${secret}` },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, relay: "connected", agentListening: true });
  assert.equal(handled, 0);
});

test("POST commands still use the command handler", async (t) => {
  const commands = [];
  const { server, origin } = await listeningServer({
    handle: async (command) => {
      commands.push(command);
      return { status: 202, body: { ok: true } };
    },
    health: async () => ({ ok: true }),
  });
  t.after(() => server.close());

  const response = await fetch(origin, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify({ run: "create-prototype" }),
  });

  assert.equal(response.status, 202);
  assert.deepEqual(commands, [{ run: "create-prototype" }]);
});
