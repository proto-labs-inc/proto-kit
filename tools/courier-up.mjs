#!/usr/bin/env node
/**
 * Bring this laptop's courier up for a codebase, in one call: the serve
 * skill's "The courier" steps, idempotent. A courier that is already up
 * is only checked; one that has its files but is stopped is started; a
 * missing one is registered, given a local port, a secret and its relay
 * address, written and started. A courier set up by an older kit has its
 * own spec brought up to this one first (run-repair.mjs, the rules
 * repair-runs.mjs applies: no tunnel, this copy of the kit's tools), and
 * is restarted when it is up on a spec older than that; no other run is
 * touched. Then it is checked locally and at the relay.
 *
 * Usage: node tools/courier-up.mjs <codebase> [--codex]
 *   --codex adds the Codex wake process (tools/feed-queue.mjs), which
 *   nothing else wakes an idle Codex session without.
 *
 * The secret is generated here and stored in courier.json (mode 600); it
 * guards the courier's local port only, stays on this laptop and is never
 * printed. The relay token comes from the site and is kept beside it.
 *
 * Prints one JSON line: { courierId, local: bool, relay, agentListening }.
 * relay is the courier's own word on its connection: "connected",
 * "connecting" or "waiting" (between attempts), "unsupported" on a Node
 * without WebSocket (older than 22), or "none" when it has no relay
 * address yet.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool, targetFor, readConfig } from "./mcp-call.mjs";
import { NEEDS_NODE_22 } from "./courier-relay.mjs";
import { alive, courierHarness, describeChange, readJson, readableSpec, repairProcesses, restartRun } from "./run-repair.mjs";

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
  const relay = await tool("register_courier", { courierId: ids.courierId });
  writeFileSync(courierPath, JSON.stringify({ codebase, port, secret, courierId: ids.courierId, libraryId: ids.libraryId, codebaseDir: source, relay: { url: relay.relayUrl, token: relay.relayToken } }, null, 2) + "\n");
  chmodSync(courierPath, 0o600);
  const processes = [
    { name: "listener", command: [process.execPath, join(kit, "tools", "courier.mjs"), dir] },
  ];
  if (codex) processes.push({ name: "codex-wake", command: [process.execPath, join(kit, "tools", "feed-queue.mjs"), dir] });
  writeFileSync(specPath, JSON.stringify({ name: `${codebase}/courier`, processes }, null, 2) + "\n");
  chmodSync(specPath, 0o600);
}

// ---- this kit's shape: the same rules repair-runs applies, this run only ----
const spec = readJson(specPath);
let specChanged = false;
if (readableSpec(spec)) {
  const harness = courierHarness(dir, spec, codex ? "codex" : null);
  const repair = repairProcesses({ name: "courier", spec, kit, runDir: dir, harness });
  if (repair.changes.length > 0) {
    const written = `${specPath}.new`;
    writeFileSync(written, JSON.stringify({ ...spec, processes: repair.processes }, null, 2) + "\n", { mode: 0o600 });
    renameSync(written, specPath);
    chmodSync(specPath, 0o600);
    specChanged = true;
    const past = (_verb, done) => done;
    console.error(`courier: ${repair.changes.map((change) => describeChange(change, past)).join(", and ")}`);
  }
}

// ---- running ----
// The supervisor reads the spec once, at start, so a courier that is up
// on a spec older than the file (rewritten just now, or by repair-runs
// earlier without --restart) is still running the old one: restart it.
const state = readJson(join(dir, "state.json"));
const up = state !== null && alive(state.pid);
const startedFromOlderSpec = up && statSync(specPath).mtimeMs > Date.parse(state.startedAt);
let restarted = false;
if (up && (specChanged || startedFromOlderSpec)) {
  if (!restartRun(dir, kit)) {
    console.error("the courier did not come back after its restart; see the run dir's daemon.log");
    process.exit(1);
  }
  restarted = true;
} else if (!up) {
  const started = supervise("start");
  if (started.status !== 0) {
    console.error(`the courier did not start: ${(started.stderr || started.stdout).trim().split("\n").pop()}`);
    process.exit(1);
  }
}

// ---- answering: locally at once, and at the relay once it connects ----
const courier = JSON.parse(readFileSync(courierPath, "utf8"));
const ask = async (url) => {
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${courier.secret}` },
      signal: AbortSignal.timeout(4000),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
};
const askLocal = async () => {
  let answer = null;
  for (let i = 0; i < 20 && !answer; i++) {
    answer = await ask(`http://127.0.0.1:${courier.port}/health`);
    if (!answer) await new Promise((r) => setTimeout(r, 250));
  }
  return answer;
};
let local = await askLocal();
// A listener whose answer carries no relay at all is running code from
// before the relay, whatever its spec says (a kit updated in place under
// a running courier). One restart puts it on this code.
if (local && local.relay === undefined && !restarted) {
  if (restartRun(dir, kit)) local = await askLocal();
}
// The relay state comes from the local answer: the courier is the one
// holding the connection, so it is the one that knows. GET /health is
// read-only, so polling here never appends a command or wakes an agent.
let relay = local?.relay ?? "none";
for (let i = 0; local?.relay !== undefined && i < 20 && relay !== "connected" && relay !== "unsupported"; i++) {
  await new Promise((r) => setTimeout(r, 500));
  relay = (await ask(`http://127.0.0.1:${courier.port}/health`))?.relay ?? relay;
}
if (relay === "unsupported") {
  const node = readJson(specPath)?.processes?.find((p) => p.name === "listener")?.command?.[0] ?? "node";
  console.error(`${NEEDS_NODE_22}, and it runs on ${node}, which has none. Point the listener in ${specPath} at Node 22 or newer, then run this again.`);
}
console.log(JSON.stringify({ courierId: courier.courierId, local: Boolean(local), relay, agentListening: local?.agentListening ?? false }));
process.exit(local ? 0 : 1);
