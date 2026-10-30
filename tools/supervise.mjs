#!/usr/bin/env node
import { acquireProcessLock } from "./process-lock.mjs";
import { assertMaintenanceAvailable } from "./maintenance-lock.mjs";
/**
 * Process supervisor for a served prototype or library: keeps its dev
 * server alive, detached from any agent session.
 *
 * A run dir holds one prototype's serving state:
 *   spec.json    what to run (written by the serve skill)
 *   state.json   what is running (written by the daemon)
 *   <name>.log   each process's combined output
 *
 * spec.json:
 *   { "name": "<codebase>/<slug>",
 *     "processes": [
 *       { "name": "dev", "cwd": "/abs/workspace", "command": ["pnpm", "dev"] }
 *     ] }
 *
 * Usage: node supervise.mjs start|stop|status <run-dir>
 * Children that exit are restarted with backoff (1s doubling to 30s).
 */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, statSync, openSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isLegacyCourierRun } from "./legacy-runs.mjs";

const [command, dirArg] = process.argv.slice(2);
if (!command || !dirArg) {
  console.error("usage: node supervise.mjs start|stop|status <run-dir>");
  process.exit(1);
}
const dir = resolve(dirArg);
if (["start", "daemon"].includes(command)) assertMaintenanceAvailable(dir);
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

// Desktop leases are separate from specs: agents may rewrite a spec, but cannot
// accidentally detach a desktop-owned preview from its tab lifetime.
const ownersPath = join(dir, "desktop-owners");
const knownOwners = new Map();
function hasOwner() {
  if (!existsSync(ownersPath)) return true; // Standalone plugin run.
  return readdirSync(ownersPath).some(name => {
    try {
      const lease = readJson(join(ownersPath, name));
      if (!Number.isInteger(lease.pid) || lease.pid <= 0 || !alive(lease.pid)) {
        rmSync(join(ownersPath, name), { force: true });
        knownOwners.delete(name);
        return false;
      }
      // An abandoned lease must never attach to an unrelated recycled PID.
      if (!knownOwners.has(name)) {
        const startedAt = execFileSync("ps", ["-p", String(lease.pid), "-o", "lstart="], { encoding: "utf8" }).trim();
        knownOwners.set(name, typeof lease.startedAt === "string" && startedAt === lease.startedAt);
      }
      return knownOwners.get(name);
    } catch { return false; }
  });
}
function isSupervisor(pid) {
  try {
    const args = execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).trim();
    return args.endsWith(`/tools/supervise.mjs daemon ${dir}`);
  } catch { return false; }
}

if (command === "start") {
  await acquireProcessLock(join(dir, "preview-start.lock"));
  assertMaintenanceAvailable(dir);
  if (!hasOwner()) { console.error("Open this prototype's tab in Proto before starting its preview."); process.exit(1); }
  // Serialize competing desktop and agent starts, including the period before
  // the detached daemon has written its state.
  const lock = join(dir, "start.lock");
  try { mkdirSync(lock); } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let holder;
    try { holder = readJson(join(lock, "owner.json")); } catch {}
    if ((holder && alive(holder.pid)) || (!holder && Date.now() - statSync(lock).mtimeMs < 10_000)) {
      console.log("a start is already in progress"); process.exit(0);
    }
    rmSync(lock, { recursive: true, force: true });
    try { mkdirSync(lock); } catch { process.exit(0); }
  }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  process.on("exit", () => rmSync(lock, { recursive: true, force: true }));
  const existing = readState();
  if (existing && alive(existing.pid) && isSupervisor(existing.pid)) {
    if (existsSync(ownersPath) && existing.lifecycle !== "desktop-tabs") {
      // Upgrade an old detached supervisor before claiming its preview. Its
      // children belonged to its original detached process group.
      try { process.kill(-existing.pid, "SIGTERM"); } catch { process.kill(existing.pid, "SIGTERM"); }
      const until = Date.now() + 3000;
      while (alive(existing.pid) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
      if (alive(existing.pid)) { console.error("Previous preview is still stopping."); process.exit(1); }
      try { process.kill(-existing.pid, "SIGKILL"); } catch {}
    } else {
      console.log(`already running (daemon pid ${existing.pid})`);
      process.exit(0);
    }
  }
  readJson(join(dir, "spec.json")); // fail fast on a bad spec before detaching
  const child = spawn(process.execPath, [process.argv[1], "daemon", dir], {
    detached: true,
    stdio: ["ignore", openSync(join(dir, "daemon.log"), "a"), openSync(join(dir, "daemon.log"), "a")],
  });
  child.unref();
  const until = Date.now() + 5000;
  while (Date.now() < until && readState()?.pid !== child.pid && alive(child.pid)) await new Promise(resolve => setTimeout(resolve, 25));
  console.log(`started (daemon pid ${child.pid})`);
  process.exit(0);
}

if (command === "stop") {
  const state = readState();
  if (!state || !alive(state.pid) || !isSupervisor(state.pid)) {
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
  if (!state || !alive(state.pid) || !isSupervisor(state.pid)) {
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
if (!hasOwner()) process.exit(0);
const spec = readJson(join(dir, "spec.json"));
const state = {
  name: spec.name,
  lifecycle: existsSync(ownersPath) ? "desktop-tabs" : "standalone",
  pid: process.pid,
  startedAt: new Date().toISOString(),
  processes: {},
};
const flush = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
const children = new Map(); // name -> ChildProcess (handles stay out of state.json)
let stopping = false;
const groups = new Set();
const timers = new Set();

function launch(proc, backoff = 1000) {
  if (stopping || !hasOwner()) { void shutdown(); return; }
  const log = openSync(join(dir, `${proc.name}.log`), "a");
  const child = spawn(proc.command[0], proc.command.slice(1), {
    detached: true,
    cwd: proc.cwd,
    env: { ...process.env, ...proc.env },
    stdio: ["ignore", log, log],
  });
  closeSync(log);
  if (child.pid) groups.add(child.pid);
  const entry = state.processes[proc.name] ?? { restarts: -1 };
  entry.pid = child.pid;
  entry.restarts += 1;
  state.processes[proc.name] = entry;
  children.set(proc.name, child);
  flush();
  child.on("error", error => { console.error(error.message); void shutdown(); });
  child.on("exit", (code) => {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
      groups.delete(child.pid);
    }
    if (stopping) return;
    console.log(`${proc.name} exited (${code}); restarting in ${backoff}ms`);
    const timer = setTimeout(() => { timers.delete(timer); launch(proc, Math.min(backoff * 2, 30_000)); }, backoff);
    timers.add(timer);
  });
}

// Owner death is checked outside Electron, so force-killing the app still
// shuts down the whole preview tree, including pnpm's grandchildren.
const ownership = setInterval(() => { if (!hasOwner()) void shutdown(); }, 500);
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(ownership);
  for (const timer of timers) clearTimeout(timer);
  for (const pid of groups) { try { process.kill(-pid, "SIGTERM"); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 300));
  for (const pid of groups) { try { process.kill(-pid, "SIGKILL"); } catch {} }
  if (readState()?.pid === process.pid) rmSync(statePath, { force: true });
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

for (const proc of spec.processes) launch(proc);
