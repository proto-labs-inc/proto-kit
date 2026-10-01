import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverLegacyRuns, inspectRetirement, retireRun } from "./retire-legacy-runs.mjs";

const tools = dirname(fileURLToPath(import.meta.url));
const began = Date.parse("2026-10-01T01:00:00.000Z");
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "retire-listener-")));
  const root = join(base, ".proto"), runDir = join(root, "fixture", "run", "courier");
  mkdirSync(runDir, { recursive: true });
  const command = [process.execPath, join(base, "kit", "tools", "feed-tail.mjs"), runDir];
  writeFileSync(join(runDir, "courier.json"), JSON.stringify({ secret: "fixture-preserved" }));
  writeFileSync(join(runDir, "spec.json"), JSON.stringify({ name: "fixture/courier", processes: [{ name: "listener", command }] }));
  return { base, root, runDir, command };
}
function running(f) {
  const supervisor = { pid: 800001, ppid: 1, startedAt: began, command: `${process.execPath} ${join(f.base, "kit", "tools", "supervise.mjs")} daemon ${f.runDir}` };
  const listener = { pid: 800002, ppid: supervisor.pid, startedAt: began, command: f.command.join(" ") };
  writeFileSync(join(f.runDir, "state.json"), JSON.stringify({ pid: supervisor.pid, startedAt: new Date(began).toISOString(), processes: { listener: { pid: listener.pid } } }));
  return [supervisor, listener];
}
test("retirement defaults to dry-run and archives stopped files only on explicit apply", async () => {
  const f = fixture();
  const before = readdirSync(f.runDir);
  const dry = await retireRun(f.runDir, { root: f.root, readProcesses: () => [] });
  assert.equal(dry.applied, false); assert.equal(dry.safe, true);
  assert.deepEqual(readdirSync(f.runDir), before);
  const applied = await retireRun(f.runDir, { root: f.root, apply: true, readProcesses: () => [] });
  assert.equal(applied.applied, true);
  assert.ok(applied.archive.startsWith(join(f.root, "retired-runs") + "/"));
  assert.equal(JSON.parse(readFileSync(join(applied.archive, "courier.json"), "utf8")).secret, "fixture-preserved");
  assert.deepEqual(discoverLegacyRuns(f.root), []);
});
test("unexpected or reused PIDs and interactive descendants block all signals", async () => {
  for (const scenario of ["reused", "interactive", "outside-parent"]) {
    const f = fixture(), table = running(f);
    if (scenario === "reused") table[0].command = "codex interactive";
    if (scenario === "interactive") table.push({ pid: 800003, ppid: table[1].pid, startedAt: began, command: "claude" });
    if (scenario === "outside-parent") table[1].ppid = 123;
    const signals = [];
    const result = await retireRun(f.runDir, { root: f.root, apply: true, readProcesses: () => table, signal: (pid) => signals.push(pid) });
    assert.equal(result.safe, false, scenario); assert.deepEqual(signals, []); assert.equal(existsSync(f.runDir), true);
  }
});
test("headless fallback descendants are individually signalled after the supervisor", async () => {
  const f = fixture(), table = running(f);
  const launcher = [process.execPath, join(f.base, "kit", "tools", "agent-launch.mjs"), f.runDir];
  table[1].command = launcher.join(" ");
  writeFileSync(join(f.runDir, "spec.json"), JSON.stringify({ processes: [{ name: "listener", command: launcher }] }));
  writeFileSync(join(f.runDir, "courier.json"), JSON.stringify({ agent: { bin: "claude", args: ["-p", "--agent", "proto:listen"], instruction: "fixture" } }));
  table.push({ pid: 800003, ppid: table[1].pid, startedAt: began, command: "claude -p --agent proto:listen fixture" });
  let active = table;
  const signals = [];
  const result = await retireRun(f.runDir, { root: f.root, apply: true, readProcesses: () => active, signal: (pid) => { signals.push(pid); active = active.filter((p) => p.pid !== pid).map((p) => p.ppid === pid ? { ...p, ppid: 1 } : p); } });
  assert.equal(result.applied, true); assert.deepEqual(signals, [800001, 800002, 800003]);
});
test("identity changes immediately before apply and symlink targets are rejected", async () => {
  const f = fixture(), table = running(f); let reads = 0;
  const result = await retireRun(f.runDir, { root: f.root, apply: true, readProcesses: () => ++reads === 1 ? table : [{ ...table[0], startedAt: began + 6000 }, table[1]], signal: () => assert.fail("must not signal") });
  assert.equal(result.safe, false);
  const link = join(dirname(f.runDir), "link"); symlinkSync(f.runDir, link);
  assert.throws(() => inspectRetirement(link, { root: f.root, table: [] }), /symbolic-link/);
  assert.throws(() => inspectRetirement(f.root, { root: f.root, table: [] }), /one codebase run/);
});

test("apply requires explicit CLI targets and partial signalling is reported truthfully", async () => {
  const f = fixture();
  const cli = spawnSync(process.execPath, [join(tools, "retire-legacy-runs.mjs"), "--root", f.root, "--apply"], { encoding: "utf8" });
  assert.equal(cli.status, 1); assert.match(cli.stderr, /explicit run-dir targets/);
  assert.equal(existsSync(f.runDir), true);
  const table = running(f); let active = table;
  const result = await retireRun(f.runDir, { root: f.root, apply: true, readProcesses: () => active, signal: (pid) => {
    active = active.filter((entry) => entry.pid !== pid).map((entry) => ({ ...entry, command: "claude interactive", ppid: 1 }));
  } });
  assert.equal(result.applied, false); assert.equal(result.partial, true); assert.equal(result.archived, false);
  assert.deepEqual(result.signalledPids, [800001]); assert.equal(existsSync(f.runDir), true);
});
test("supervisor startup, direct daemon, stop and repair never revive legacy runs", () => {
  const f = fixture(); const original = readFileSync(join(f.runDir, "spec.json"), "utf8");
  for (const command of ["start", "daemon", "stop"]) {
    const result = spawnSync(process.execPath, [join(tools, "supervise.mjs"), command, f.runDir], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /retired/);
  }
  const repair = spawnSync(process.execPath, [join(tools, "repair-runs.mjs"), "--restart"], { encoding: "utf8", env: { ...process.env, HOME: f.base } });
  assert.equal(repair.status, 0, repair.stderr);
  assert.equal(readFileSync(join(f.runDir, "spec.json"), "utf8"), original);
  assert.equal(existsSync(join(f.runDir, "daemon.log")), false);
});
test("archive IO failure preserves structured partial signalling results", async () => {
  const f = fixture(); let active = running(f);
  writeFileSync(join(f.root, "retired-runs"), "fixture obstacle");
  const result = await retireRun(f.runDir, { root: f.root, apply: true, readProcesses: () => active, signal: (pid) => {
    active = active.filter((entry) => entry.pid !== pid).map((entry) => entry.ppid === pid ? { ...entry, ppid: 1 } : entry);
  } });
  assert.equal(result.applied, false); assert.equal(result.partial, true); assert.equal(result.archived, false);
  assert.deepEqual(result.signalledPids, [800001, 800002]); assert.match(result.reason, /archive failed/);
  assert.equal(existsSync(f.runDir), true);
});
test("real timer-only background process fixture can be retired without external services", async () => {
  const f = fixture(), kitTools = join(f.base, "kit", "tools");
  mkdirSync(kitTools, { recursive: true });
  writeFileSync(join(kitTools, "feed-tail.mjs"), "setInterval(() => {}, 1000);\n");
  writeFileSync(join(kitTools, "supervise.mjs"), `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; import {join} from 'node:path'; const dir=process.argv[3]; const child=spawn(process.execPath,[${JSON.stringify(join(kitTools, "feed-tail.mjs"))},dir],{stdio:'ignore'}); writeFileSync(join(dir,'state.json'),JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),processes:{listener:{pid:child.pid}}})); process.on('SIGTERM',()=>{try{child.kill('SIGTERM')}catch{} process.exit(0)}); setInterval(()=>{},1000);\n`);
  const daemon = spawn(process.execPath, [join(kitTools, "supervise.mjs"), "daemon", f.runDir], { stdio: "ignore" });
  try {
    for (let i = 0; i < 40 && !existsSync(join(f.runDir, "state.json")); i++) await new Promise((done) => setTimeout(done, 25));
    assert.equal(existsSync(join(f.runDir, "state.json")), true);
    const dry = await retireRun(f.runDir, { root: f.root }); assert.equal(dry.safe, true, dry.reason); assert.equal(dry.applied, false);
    const result = await retireRun(f.runDir, { root: f.root, apply: true });
    assert.equal(result.applied, true, result.reason);
    assert.equal(existsSync(f.runDir), false);
  } finally { if (daemon.exitCode === null) daemon.kill("SIGTERM"); }
});
