#!/usr/bin/env node
/**
 * Process supervisor for a served prototype: keeps the dev server and the
 * tunnel connector alive together, detached from any agent session.
 *
 * A run dir holds one prototype's serving state:
 *   spec.json    what to run (written by the serve skill)
 *   state.json   what is running (written by the daemon)
 *   <name>.log   each process's combined output
 *
 * spec.json:
 *   { "name": "<codebase>/<slug>",
 *     "processes": [
 *       { "name": "dev", "cwd": "/abs/workspace", "command": ["pnpm", "dev"],
 *         "env": { "PROTO_TUNNEL": "1" } },
 *       { "name": "tunnel", "command": ["cloudflared", "tunnel", "run", "--token", "…"] }
 *     ] }
 *
 * Usage: node supervise.mjs start|stop|status <run-dir>
 * Children that exit are restarted with backoff (1s doubling to 30s).
 */
import { spawn } from "node:child_process";
import { openSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isLegacyCourierRun } from "./legacy-runs.mjs";

const [command, dirArg] = process.argv.slice(2);
if (!command || !dirArg) {
  console.error("usage: node supervise.mjs start|stop|status <run-dir>");
  process.exit(1);
}
const dir = resolve(dirArg);
const statePath = join(dir, "state.json");
if (["start", "daemon", "stop"].includes(command) && isLegacyCourierRun(dir)) {
  console.error("This is a retired courier run. It cannot be started or repaired. Preview safe retirement with retire-legacy-runs.mjs.");
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readState = () => {
  try {
    return readJson(statePath);
  } catch {
    return null;
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (command === "start") {
  const existing = readState();
  if (existing && alive(existing.pid)) {
    console.log(`already running (daemon pid ${existing.pid})`);
    process.exit(0);
  }
  readJson(join(dir, "spec.json")); // fail fast on a bad spec before detaching
  const child = spawn(process.execPath, [process.argv[1], "daemon", dir], {
    detached: true,
    stdio: ["ignore", openSync(join(dir, "daemon.log"), "a"), openSync(join(dir, "daemon.log"), "a")],
  });
  child.unref();
  console.log(`started (daemon pid ${child.pid})`);
  process.exit(0);
}

if (command === "stop") {
  const state = readState();
  if (!state || !alive(state.pid)) {
    console.log("not running");
    rmSync(statePath, { force: true });
    process.exit(0);
  }
  process.kill(state.pid, "SIGTERM"); // daemon kills its children and exits
  console.log(`stopping (daemon pid ${state.pid})`);
  process.exit(0);
}

if (command === "status") {
  const state = readState();
  if (!state || !alive(state.pid)) {
    console.log("stopped");
    process.exit(1);
  }
  console.log(`running (daemon pid ${state.pid}, since ${state.startedAt})`);
  for (const [name, p] of Object.entries(state.processes)) {
    const live = alive(p.pid);
    console.log(`  ${name}: ${live ? "up" : "DOWN"} (pid ${p.pid}, restarts ${p.restarts})`);
  }
  process.exit(0);
}

if (command !== "daemon") {
  console.error(`unknown command: ${command}`);
  process.exit(1);
}

// ---- daemon ----
const spec = readJson(join(dir, "spec.json"));
const state = {
  name: spec.name,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  processes: {},
};
const flush = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const children = new Map(); // name -> ChildProcess (handles stay out of state.json)
let stopping = false;

function launch(proc, backoff = 1000) {
  const log = openSync(join(dir, `${proc.name}.log`), "a");
  const child = spawn(proc.command[0], proc.command.slice(1), {
    cwd: proc.cwd,
    env: { ...process.env, ...proc.env },
    stdio: ["ignore", log, log],
  });
  const entry = state.processes[proc.name] ?? { restarts: -1 };
  entry.pid = child.pid;
  entry.restarts += 1;
  state.processes[proc.name] = entry;
  children.set(proc.name, child);
  flush();
  child.on("exit", (code) => {
    if (stopping) return;
    console.log(`${proc.name} exited (${code}); restarting in ${backoff}ms`);
    setTimeout(() => launch(proc, Math.min(backoff * 2, 30_000)), backoff);
  });
}

for (const proc of spec.processes) launch(proc);

process.on("SIGTERM", () => {
  stopping = true;
  for (const child of children.values()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  rmSync(statePath, { force: true });
  process.exit(0);
});
