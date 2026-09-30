import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDevServer, whoAnswers } from "./dev-server.mjs";
import { pickPort, portIsFree } from "./ports.mjs";

// A listener on one loopback address only, the way Vite binds localhost
// as ::1 on a Mac: the address a 127.0.0.1 probe never sees.
function listenOn(host, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

test("a port held on ::1 alone is not free", async () => {
  const held = await listenOn("::1");
  const { port } = held.address();
  try {
    assert.equal(await portIsFree(port), false);
  } finally {
    held.close();
  }
  assert.equal(await portIsFree(port), true);
});

test("pickPort skips a port held on ::1 alone", async () => {
  // A range starting at a port nobody holds, then the same range with
  // its first port taken on ::1 only.
  const first = await pickPort({ from: 47000, to: 47100 });
  const held = await listenOn("::1", first);
  try {
    const next = await pickPort({ from: 47000, to: 47100 });
    assert.notEqual(next, first);
    assert.ok(next > first);
  } finally {
    held.close();
  }
});

// A workspace folder with its manifest and identity, pointed at `port`.
function workspaceAt(port, { identity = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ports-test-"));
  mkdirSync(join(root, "public"), { recursive: true });
  writeFileSync(join(root, "public", "prototype.json"), JSON.stringify({ schemaVersion: 2, name: "mine", port }));
  if (identity) writeFileSync(join(root, "public", "__proto-workspace.json"), JSON.stringify({ codebase: "cb", slug: "mine", token: "own-token" }));
  return root;
}

// A dev server standing in for another prototype's: it serves that
// prototype's manifest and identity on the port.
function otherApp(port, { name = "theirs", token = "their-token" } = {}) {
  return new Promise((resolve) => {
    const server = createHttp((req, res) => {
      if (req.url === "/prototype.json") return res.end(JSON.stringify({ schemaVersion: 2, name, port }));
      if (req.url === "/__proto-workspace.json") return res.end(JSON.stringify({ codebase: "other", slug: name, token }));
      res.statusCode = 404;
      res.end();
    });
    server.listen(port, "::1", () => resolve(server));
  });
}

test("another prototype's server on the port is named, and nothing renders in it", async () => {
  const port = await pickPort({ from: 47200, to: 47300 });
  const other = await otherApp(port);
  const workspace = workspaceAt(port);
  try {
    assert.deepEqual(await whoAnswers(`http://localhost:${port}`, workspace), { who: "other", found: 'the prototype "theirs"' });
    await assert.rejects(ensureDevServer({ workspace, logPath: join(workspace, "dev.log") }), /port \d+ is serving the prototype "theirs", not /);
  } finally {
    other.close();
  }
});

test("the workspace's own server is known by its token, even under another name", async () => {
  const port = await pickPort({ from: 47300, to: 47400 });
  const own = await otherApp(port, { name: "renamed", token: "own-token" });
  const workspace = workspaceAt(port);
  try {
    assert.deepEqual(await whoAnswers(`http://localhost:${port}`, workspace), { who: "this" });
    const dev = await ensureDevServer({ workspace, logPath: join(workspace, "dev.log") });
    assert.equal(dev.started, false);
  } finally {
    own.close();
  }
});

test("a workspace from before the identity file is known by its name", async () => {
  const port = await pickPort({ from: 47400, to: 47500 });
  const server = await otherApp(port, { name: "mine" });
  const workspace = workspaceAt(port, { identity: false });
  try {
    assert.deepEqual(await whoAnswers(`http://localhost:${port}`, workspace), { who: "this" });
  } finally {
    server.close();
  }
});
