#!/usr/bin/env node
/**
 * Bring this laptop's courier up for a codebase, in one call: the serve
 * skill's "The courier" steps, idempotent. A courier that is already up
 * is only checked; one that has its files but is stopped is started; a
 * missing one is registered, given a port, a secret and a tunnel,
 * written and started.
 *
 * Usage: node tools/courier-up.mjs <codebase> [--codex]
 *   --codex adds the Codex wake process (tools/feed-queue.mjs), which
 *   nothing else wakes an idle Codex session without.
 *
 * The secret is generated here, stored in courier.json (mode 600) and
 * registered with the site; it is never printed.
 *
 * Prints one JSON line: { courierId, hostname, local: bool, edge: bool,
 * agentListening }. edge is false while Cloudflare's edge is still
 * settling or when the network blocks the tunnel (port 7844).
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, targetFor, readConfig } from "./mcp-call.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const codebase = args.find((a) => !a.startsWith("--"));
const codex = args.includes("--codex");
if (!codebase) {
  console.error("usage: node tools/courier-up.mjs <codebase> [--codex]");
  process.exit(1);
}
const home = join(process.env.HOME ?? "", ".proto", codebase);
const dir = join(home, "run", "courier");
const courierPath = join(dir, "courier.json");
const specPath = join(dir, "spec.json");
mkdirSync(dir, { recursive: true });

const target = targetFor(readConfig(), { codebase });
const tool = async (name, input) => {
  const result = await callTool(name, input, target);
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
const supervise = (command) => spawnSync(process.execPath, [join(kit, "tools", "supervise.mjs"), command, dir], { encoding: "utf8" });

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// ---- the files: made once, kept from then on ----
if (!existsSync(courierPath) || !existsSync(specPath)) {
  const source = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source?.path ?? home;
  // Identity once per laptop and codebase: a courier that exists keeps its ids.
  let ids = null;
  if (existsSync(courierPath)) {
    const old = JSON.parse(readFileSync(courierPath, "utf8"));
    if (old.courierId) ids = { courierId: old.courierId, libraryId: old.libraryId };
  }
  if (!ids) ids = await tool("register_courier", { codebase });
  const port = await freePort();
  const secret = randomBytes(24).toString("hex");
  const tunnel = await tool("provision_tunnel", { kind: "courier", courierId: ids.courierId, port });
  await tool("register_courier", { courierId: ids.courierId, secret });
  writeFileSync(courierPath, JSON.stringify({ codebase, port, secret, courierId: ids.courierId, libraryId: ids.libraryId, codebaseDir: source, hostname: tunnel.hostname }, null, 2) + "\n");
  chmodSync(courierPath, 0o600);
  const processes = [
    { name: "listener", command: [process.execPath, join(kit, "tools", "courier.mjs"), dir] },
    { name: "tunnel", command: ["cloudflared", "tunnel", "run", "--token", tunnel.connectorToken] },
  ];
  if (codex) processes.push({ name: "codex-wake", command: [process.execPath, join(kit, "tools", "feed-queue.mjs"), dir] });
  writeFileSync(specPath, JSON.stringify({ name: `${codebase}/courier`, processes }, null, 2) + "\n");
  chmodSync(specPath, 0o600);
}

// ---- running ----
const status = supervise("status");
if (!/running/.test(status.stdout)) {
  const started = supervise("start");
  if (started.status !== 0) {
    console.error(`the courier did not start: ${(started.stderr || started.stdout).trim().split("\n").pop()}`);
    process.exit(1);
  }
}

// ---- answering: locally at once, through the edge once it settles ----
const courier = JSON.parse(readFileSync(courierPath, "utf8"));
const ask = async (url) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${courier.secret}`, "content-type": "application/json" },
      body: JSON.stringify({ status: true }),
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};
let local = null;
for (let i = 0; i < 20 && !local; i++) {
  local = await ask(`http://127.0.0.1:${courier.port}`);
  if (!local) await new Promise((r) => setTimeout(r, 250));
}
let edge = null;
if (courier.hostname) {
  for (let i = 0; i < 10 && !edge; i++) {
    edge = await ask(`https://${courier.hostname}`);
    if (!edge) await new Promise((r) => setTimeout(r, 2000));
  }
}
console.log(JSON.stringify({ courierId: courier.courierId, hostname: courier.hostname ?? null, local: Boolean(local), edge: Boolean(edge), agentListening: local?.agentListening ?? false }));
process.exit(local ? 0 : 1);
