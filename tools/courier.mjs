#!/usr/bin/env node
/**
 * The courier (MAA-130): the website→laptop command daemon. Listens on a
 * local port (exposed publicly via the project's agent-<project> tunnel),
 * accepts enumerated JSON commands, and runs headless agent work in the
 * project — one run at a time, the rest queued, every command acked on
 * receipt.
 *
 * Command handling is transport-agnostic: handle() takes a parsed JSON
 * command however it arrived. courier-http.mjs is the current transport;
 * a WebSocket transport replaces that file only.
 *
 * Commands v1:
 *   { "run": "<prompt-name>", "briefId"?: "…" }  → queue a headless run
 *   { "status": true }                            → runs + serving health
 *   { "restart-serving": "<slug>" | true }        → restart serving (one|all)
 *
 * Usage: node courier.mjs <run-dir>     (reads <run-dir>/courier.json)
 *
 * courier.json:
 *   { "project": "acme",
 *     "projectDir": "/abs/~/.proto/acme",
 *     "port": 5300,
 *     "secret": "…",
 *     "run": { "command": ["claude", "-p", "{instruction}"],
 *              "instruction": "run prompt {prompt} from the totypes MCP server" } }
 * The spawned command line is config, not code: {instruction} expands in
 * command, {prompt} in instruction (+ " for brief {briefId}" when given),
 * so the real MCP prompt wiring — and test stubs — are config edits.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { serveHttp } from "./courier-http.mjs";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node courier.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
const logsDir = join(runDir, "runs");
mkdirSync(logsDir, { recursive: true });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- runs: one at a time, FIFO queue ----
const runs = []; // {id, prompt, briefId, state, startedAt?, endedAt?, exitCode?}
let current = null;

function instructionFor(cmd) {
  let text = config.run.instruction.replaceAll("{prompt}", cmd.run);
  if (cmd.briefId) text += ` for brief ${cmd.briefId}`;
  return text;
}

function startNext() {
  if (current) return;
  const next = runs.find((r) => r.state === "queued");
  if (!next) return;
  current = next;
  next.state = "running";
  next.startedAt = new Date().toISOString();
  const log = openSync(join(logsDir, `${next.id}.log`), "a");
  const argv = config.run.command.map((part) =>
    part.replaceAll("{instruction}", next.instruction),
  );
  const child = spawn(argv[0], argv.slice(1), {
    cwd: config.projectDir,
    stdio: ["ignore", log, log],
  });
  next.pid = child.pid;
  child.on("exit", (code) => {
    next.state = code === 0 ? "done" : "failed";
    next.endedAt = new Date().toISOString();
    next.exitCode = code;
    current = null;
    startNext();
  });
  child.on("error", () => {
    next.state = "failed";
    next.endedAt = new Date().toISOString();
    current = null;
    startNext();
  });
}

// ---- serving health: sibling run dirs under <project>/run/ ----
function servingState() {
  const parent = dirname(runDir);
  const out = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || join(parent, entry.name) === runDir) continue;
    let state = null;
    try {
      state = JSON.parse(readFileSync(join(parent, entry.name, "state.json"), "utf8"));
    } catch {}
    const up = state ? alive(state.pid) : false;
    out.push({
      slug: entry.name,
      supervisor: up ? "up" : "down",
      processes: up
        ? Object.fromEntries(
            Object.entries(state.processes).map(([name, p]) => [
              name,
              { status: alive(p.pid) ? "up" : "down", restarts: p.restarts },
            ]),
          )
        : {},
    });
  }
  return out;
}

const superviseTool = fileURLToPath(new URL("./supervise.mjs", import.meta.url));
function restartServing(which) {
  const parent = dirname(runDir);
  const targets = servingState()
    .filter((s) => which === true || s.slug === which)
    .map((s) => join(parent, s.slug));
  for (const dir of targets) {
    // stop is sync-fast (sends SIGTERM); start re-reads spec.json
    spawn(process.execPath, [superviseTool, "stop", dir], { stdio: "ignore" }).on(
      "exit",
      () => setTimeout(() => spawn(process.execPath, [superviseTool, "start", dir], { stdio: "ignore" }), 500),
    );
  }
  return targets.length;
}

// ---- the transport-agnostic handler ----
export async function handle(cmd) {
  if (cmd && typeof cmd.run === "string" && cmd.run.length > 0) {
    const run = {
      id: randomUUID().slice(0, 8),
      prompt: cmd.run,
      briefId: cmd.briefId,
      instruction: instructionFor(cmd),
      state: "queued",
      queuedAt: new Date().toISOString(),
    };
    runs.push(run);
    startNext(); // ack does not wait on the spawn's outcome
    return {
      status: 202,
      body: { ok: true, runId: run.id, state: run.state, position: runs.filter((r) => r.state === "queued").length },
    };
  }
  if (cmd && cmd.status) {
    return {
      status: 200,
      body: {
        project: config.project,
        current: current
          ? { id: current.id, prompt: current.prompt, startedAt: current.startedAt }
          : null,
        queue: runs.filter((r) => r.state === "queued").map((r) => ({ id: r.id, prompt: r.prompt })),
        recent: runs
          .filter((r) => r.state === "done" || r.state === "failed")
          .slice(-5)
          .map((r) => ({ id: r.id, prompt: r.prompt, state: r.state, exitCode: r.exitCode })),
        serving: servingState(),
      },
    };
  }
  if (cmd && cmd["restart-serving"]) {
    const count = restartServing(cmd["restart-serving"]);
    return { status: 202, body: { ok: true, restarting: count } };
  }
  return { status: 400, body: { error: "unknown command; expected run | status | restart-serving" } };
}

serveHttp({ port: config.port, secret: config.secret, handle }, () =>
  console.log(`courier for ${config.project} on 127.0.0.1:${config.port}`),
);
