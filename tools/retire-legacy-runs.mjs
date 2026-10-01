#!/usr/bin/env node
/** Dry-run by default. Safely retire only validated legacy command-listener runs.
 * node retire-legacy-runs.mjs [<run-dir>…] [--root <proto-root>] [--apply]
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isLegacyCourierRun, LEGACY_SCRIPTS, readLegacyJson } from "./legacy-runs.mjs";

export function processTable() {
  const output = execFileSync("ps", ["-ww", "-axo", "pid=,ppid=,lstart=,stat=,command="], { encoding: "utf8" });
  return output.split("\n").flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(\S+)\s+(.+)$/);
    return match && !match[4].startsWith("Z") ? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: Date.parse(match[3]), command: match[5] }] : [];
  });
}

function validatedPath(runDir, root) {
  const absolute = resolve(runDir), protoRoot = realpathSync(root);
  if (lstatSync(absolute).isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Error("symbolic-link run paths are not retired automatically");
  const parts = relative(protoRoot, absolute).split(sep);
  if (parts.length !== 3 || parts[1] !== "run" || parts.some((part) => !part || part === "." || part === "..") || parts[0] === "retired-runs") throw new Error("target must be one codebase run directory directly under the selected Proto root");
  if (!lstatSync(absolute).isDirectory()) throw new Error("target is not a directory");
  return { absolute, protoRoot, codebase: parts[0], name: parts[2] };
}

function descendants(table, pid) {
  const out = [], seen = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const entry of table) if (seen.has(entry.ppid) && !seen.has(entry.pid)) { seen.add(entry.pid); out.push(entry); changed = true; }
  }
  return out;
}

const tokens = (command) => command.trim().split(/\s+/);
const sameProcess = (a, b) => a && b && a.pid === b.pid && a.startedAt === b.startedAt && a.command === b.command;
const executable = (command) => basename(tokens(command)[0]);

function headlessFallback(entry, config, parent, runDir) {
  if (!parent || !["agent-launch.mjs", "feed-drive.mjs"].some((script) => parent.command.includes(`/tools/${script} ${runDir}`))) return false;
  const args = tokens(entry.command);
  if (config.agent && basename(config.agent.bin ?? "") === "claude" && executable(entry.command) === "claude") {
    // Print mode, configured agent identity, and verified launcher ancestry:
    // an interactive Claude session can never satisfy these checks.
    const expected = config.agent.args ?? [];
    if (!expected.includes("-p") || expected[expected.indexOf("--agent") + 1] !== "proto:listen") return false;
    const actual = entry.command.slice(entry.command.indexOf(" ") + 1);
    const fresh = [...expected, config.agent.instruction].join(" ");
    const sessionId = readLegacyJson(join(runDir, "session.json"))?.sessionId;
    const resumed = sessionId && Array.isArray(config.agent.resumeArgs) ? [...expected, ...config.agent.resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId)), config.agent.resumeInstruction ?? config.agent.instruction].join(" ") : null;
    return actual === fresh || actual === resumed;
  }
  if (config.codexAgent && basename(config.codexAgent.bin ?? "") === "codex" && executable(entry.command) === "codex") {
    const agent = config.codexAgent;
    if (agent.args?.[0] !== "exec" || args[1] !== "exec" || typeof agent.instruction !== "string") return false;
    const variants = [agent.args];
    const sessionId = readLegacyJson(join(runDir, "codex-session.json"))?.sessionId;
    if (sessionId && Array.isArray(agent.resumeArgs)) variants.push([agent.args[0], ...agent.resumeArgs.map((arg) => arg.replaceAll("{sessionId}", sessionId)), ...agent.args.slice(1)]);
    const actual = entry.command.slice(entry.command.indexOf(" ") + 1);
    return variants.some((vector) => {
      const marker = agent.instruction.indexOf("{command}");
      if (marker === -1) return actual === [...vector, agent.instruction].join(" ");
      const prefix = vector.join(" ") + " " + agent.instruction.slice(0, marker), suffix = agent.instruction.slice(marker + "{command}".length);
      if (!actual.startsWith(prefix) || !actual.endsWith(suffix)) return false;
      try { const command = JSON.parse(actual.slice(prefix.length, suffix.length ? -suffix.length : undefined)); return command && typeof command === "object" && !Array.isArray(command); } catch { return false; }
    });
  }
  return false;
}

export function inspectRetirement(runDir, { root, table = processTable() } = {}) {
  const target = validatedPath(runDir, root);
  const spec = readLegacyJson(join(target.absolute, "spec.json"));
  if (!isLegacyCourierRun(target.absolute, spec)) return { ...target, safe: false, reason: "not a legacy command-listener run", processes: [] };
  const state = readLegacyJson(join(target.absolute, "state.json"));
  const config = readLegacyJson(join(target.absolute, "courier.json")) ?? {};
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const supervisor = byPid.get(state?.pid);
  const block = (reason) => ({ ...target, safe: false, reason, processes: [] });
  if (!supervisor) {
    const recorded = Object.values(state?.processes ?? {}).map((entry) => entry?.pid);
    if (table.some((entry) => recorded.includes(entry.pid) || (entry.pid !== process.pid && entry.command.includes(target.absolute) &&
        ([...LEGACY_SCRIPTS].some((script) => entry.command.includes(`/tools/${script}`)) || entry.command.includes("/tools/supervise.mjs daemon"))))) return block("processes may still own this stopped run; manual inspection required");
    return { ...target, safe: true, reason: "already stopped", processes: [] };
  }
  if (supervisor.pid <= 1 || supervisor.pid === process.pid || supervisor.pid === process.ppid) return block("supervisor PID is not a retireable background process");
  const supervisorMatch = supervisor.command.match(/^(?:\S*\/)?node(?:js)?\s+(.+\/tools\/supervise\.mjs)\s+daemon\s+(.+)$/);
  if (!supervisorMatch || supervisorMatch[2] !== target.absolute || !Number.isFinite(supervisor.startedAt) || Math.abs(supervisor.startedAt - Date.parse(state.startedAt)) > 5000 || !Number.isFinite(Date.parse(state.startedAt))) return block("supervisor identity or start time does not match saved state");
  const children = descendants(table, supervisor.pid);
  const recorded = Object.entries(state.processes ?? {});
  const expected = new Map((Array.isArray(spec?.processes) ? spec.processes : []).map((entry) => [entry.name, entry]));
  const known = new Set([supervisor.pid]);
  for (const child of children) {
    const parent = byPid.get(child.ppid);
    if (!known.has(child.ppid)) return block("a descendant's ownership cannot be established");
    const stateEntry = recorded.find(([, value]) => value.pid === child.pid);
    const entry = stateEntry ? expected.get(stateEntry[0]) : null;
    const command = entry?.command;
    const retiredScript = Array.isArray(command) && /^(node|nodejs)$/.test(basename(command[0] ?? "")) &&
      typeof command[1] === "string" && LEGACY_SCRIPTS.has(basename(command[1])) &&
      (command[2] === target.absolute || basename(command[1]) === "feed-watch-all.mjs");
    const localTunnel = Array.isArray(command) && basename(command[0]) === "cloudflared" && command[1] === "tunnel" && command[2] === "run";
    const matchesSpec = child.ppid === supervisor.pid && Array.isArray(command) && child.command === command.join(" ") && (retiredScript || localTunnel);
    if (!matchesSpec && !headlessFallback(child, config, parent, target.absolute)) return block("unknown or interactive descendant; no processes will be signalled");
    known.add(child.pid);
  }
  for (const [, value] of recorded) if (byPid.has(value.pid) && !known.has(value.pid)) return block("a saved child PID is outside the verified supervisor ancestry");
  return { ...target, safe: true, reason: "verified background supervisor and descendants", processes: [supervisor, ...children] };
}

export async function retireRun(runDir, { root, apply = false, readProcesses = processTable, signal = (pid) => process.kill(pid, "SIGTERM"), sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now } = {}) {
  const plan = inspectRetirement(runDir, { root, table: readProcesses() });
  const signalledPids = [];
  const summary = { runDir: plan.absolute, safe: plan.safe, reason: plan.reason, pids: plan.processes.map((entry) => entry.pid), applied: false, signalledPids };
  const partial = (reason) => ({ ...summary, safe: false, partial: signalledPids.length > 0, reason, archived: false });
  if (!apply || !plan.safe) return summary;
  const fresh = inspectRetirement(runDir, { root, table: readProcesses() });
  if (!fresh.safe || fresh.processes.length !== plan.processes.length || !fresh.processes.every((entry, index) => sameProcess(entry, plan.processes[index]) && entry.ppid === plan.processes[index].ppid)) return { ...summary, safe: false, reason: "process identities changed after inspection" };
  // Stop the supervisor first so it cannot respawn a listener. Old launchers
  // did not forward signals, so positively identified descendants are signalled
  // individually afterwards; an adopted child may now have init as its parent.
  for (const entry of plan.processes) {
    const table = readProcesses();
    const known = new Set(plan.processes.map((item) => item.pid));
    if (plan.processes.some((item) => descendants(table, item.pid).some((descendant) => !known.has(descendant.pid)))) return partial("a new descendant appeared; remaining processes were not signalled and the run was not archived");
    const current = table.find((item) => item.pid === entry.pid);
    if (!current) continue;
    if (!sameProcess(current, entry) || (current.ppid !== entry.ppid && current.ppid !== 1)) return partial("a process identity changed; remaining processes were not signalled and the run was not archived");
    try { signal(entry.pid); signalledPids.push(entry.pid); } catch (error) { if (error.code !== "ESRCH") return partial(`could not signal verified process ${entry.pid}; the run was not archived`); }
  }
  const deadline = now() + 5000;
  for (;;) {
    const table = readProcesses();
    if (!plan.processes.some((entry) => table.some((current) => sameProcess(entry, current)))) break;
    if (now() >= deadline) return partial("verified processes have not exited; run was not archived");
    await sleep(100);
  }
  try {
    const archiveRoot = join(plan.protoRoot, "retired-runs", plan.codebase);
    mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    const archive = join(archiveRoot, `${plan.name}-${new Date(now()).toISOString().replaceAll(":", "-")}`);
    if (existsSync(archive)) return partial("archive destination already exists; no files were overwritten and the run was not archived");
    renameSync(plan.absolute, archive);
    return { ...summary, applied: true, partial: false, archived: true, archive };
  } catch (error) {
    return partial(`archive failed (${error.code ?? error.message}); the run was not archived`);
  }
}

export function discoverLegacyRuns(root) {
  const dirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name); } catch { return []; } };
  return dirs(root).filter((name) => name !== "retired-runs").flatMap((name) => dirs(join(root, name, "run")).map((run) => join(root, name, "run", run))).filter((dir) => isLegacyCourierRun(dir));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf("--root");
  const root = resolve(at === -1 ? join(process.env.HOME ?? "", ".proto") : args[at + 1] ?? "");
  const apply = args.includes("--apply");
  const named = args.filter((arg, index) => arg !== "--apply" && arg !== "--root" && (at === -1 || index !== at + 1));
  try {
    if (args.some((arg) => arg.startsWith("--") && !["--root", "--apply"].includes(arg)) || (at !== -1 && !args[at + 1])) throw new Error("usage: retire-legacy-runs.mjs [<run-dir>…] [--root <proto-root>] [--apply]");
    if (apply && named.length === 0) throw new Error("--apply requires explicit run-dir targets; use the default dry-run to inspect discovered runs first");
    const targets = named.length ? named.map((dir) => resolve(dir)) : discoverLegacyRuns(root);
    for (const dir of targets) console.log(JSON.stringify(await retireRun(dir, { root, apply })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
