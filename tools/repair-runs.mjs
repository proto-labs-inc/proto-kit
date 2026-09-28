#!/usr/bin/env node
/**
 * Bring this laptop's run specs up to what this copy of the kit
 * expects, and say plainly what changed. The update skill runs it
 * after the plugin updates; run it on its own after pulling the kit
 * by hand.
 *
 * A new version can change what a run is made of, and nothing
 * rewrites the spec of a run that already exists: it keeps the shape
 * it was created with until something repairs it. That is not
 * hypothetical. The Codex wake (`feed-queue.mjs`) arrived in the
 * courier's run spec after couriers existed, and until this has run
 * over them the site's commands reach a Codex session never: they
 * pile up in the feed with nothing to deliver them.
 *
 * Two rules, over every run dir under `~/.proto/<codebase>/run/`:
 *
 *   1. A courier's processes. On Codex a courier runs `codex-wake`
 *      beside the listener and the tunnel; on Claude Code and Cursor
 *      it does not, because the Monitor tool and the open chat wake
 *      those sessions themselves. Which harness a courier belongs to
 *      is read per courier, never per laptop: one laptop holds a
 *      Codex courier for one codebase and a Claude Code courier for
 *      another, and this developer's does.
 *   2. The copy of the kit a spec points at. Every
 *      `node <kit>/tools/….mjs` in a spec is an absolute path into
 *      the copy that wrote it. An update installs a new copy
 *      elsewhere and leaves the spec naming the old one, which the
 *      harness sweeps away sooner or later; the process then dies at
 *      its next restart and the supervisor restarts it into the same
 *      nothing.
 *
 * Nothing else. Ports, tunnels and connector tokens belong to
 * `host-library.mjs` and the serve skill: this never provisions,
 * never registers, and never invents a process it has no token for.
 * Run it twice and the second run changes nothing.
 *
 * A run that is up is never restarted without `--restart`. The spec
 * is read when the supervisor starts, so rewriting it under a live
 * run is safe; restarting is what costs something, and the report
 * names which runs are waiting on one and what it interrupts.
 *
 * Usage: node repair-runs.mjs [<codebase>…] [options]
 *   --check                       say what would change, change nothing
 *   --restart                     restart the runs whose spec changed in a way
 *                                 only a restart applies
 *   --harness claude|codex|cursor what this laptop's agent is, for a courier
 *                                 whose own files do not say
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESSES = ["claude", "codex", "cursor"];
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const restart = argv.includes("--restart");
const harnessArg = argv[argv.indexOf("--harness") + 1];
if (argv.includes("--harness") && !HARNESSES.includes(harnessArg)) {
  console.error(`--harness takes one of: ${HARNESSES.join(", ")}`);
  process.exit(1);
}
const told = argv.includes("--harness") ? harnessArg : null;
const named = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--harness");

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(process.env.HOME ?? "", ".proto");
const supervise = join(kit, "tools", "supervise.mjs");
const did = (verb, past) => (check ? `would ${verb}` : past);

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
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
const dirs = (path) => {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
};

let codebases = dirs(root).filter((name) => !name.startsWith("chrome"));
if (named.length > 0) {
  const missing = named.filter((name) => !codebases.includes(name));
  if (missing.length > 0) {
    console.error(`no such codebase under ~/.proto: ${missing.join(", ")}`);
    process.exit(1);
  }
  codebases = named;
}
if (codebases.length === 0) process.exit(0); // nothing set up here: nothing to say

console.error(`… repairing against ${kit}`);
const repaired = [];
const pending = [];
const skipped = [];

for (const codebase of codebases) {
  const runRoot = join(root, codebase, "run");
  for (const name of dirs(runRoot)) {
    const runDir = join(runRoot, name);
    const specPath = join(runDir, "spec.json");
    const spec = readJson(specPath);
    const readable =
      spec !== null &&
      Array.isArray(spec.processes) &&
      spec.processes.every((p) => typeof p?.name === "string" && Array.isArray(p.command));
    if (!readable) {
      if (existsSync(specPath)) skipped.push(`${codebase}/${name}: its spec.json does not read as a run spec; left alone.`);
      continue;
    }

    const changes = [];
    const processes = spec.processes.map((proc) => ({ ...proc, command: [...proc.command] }));
    let onlyAtNextStart = true; // a rewritten path costs nothing until the process restarts anyway

    // Rule 1: the courier's processes, per this courier's harness.
    if (name === "courier") {
      const harness = courierHarness(runDir, spec);
      const wake = processes.findIndex((p) => p.name === "codex-wake");
      if (harness === "codex" && wake === -1) {
        processes.push({ name: "codex-wake", command: ["node", join(kit, "tools", "feed-queue.mjs"), runDir] });
        changes.push(`${did("add", "added")} the Codex wake`);
        onlyAtNextStart = false;
      } else if (harness && harness !== "codex" && wake !== -1) {
        processes.splice(wake, 1);
        changes.push(`${did("remove", "removed")} the Codex wake, which belongs only to a Codex courier`);
        onlyAtNextStart = false;
      } else if (!harness && wake === -1) {
        skipped.push(
          `${codebase}/courier: nothing here says which agent this courier belongs to, so whether it needs the Codex wake is a guess; run this again with --harness to settle it.`,
        );
      }
    }

    // Rule 2: the copy of the kit each process runs from.
    const repointed = [];
    let gone = false;
    for (const proc of processes) {
      for (let i = 0; i < proc.command.length; i += 1) {
        const current = kitScript(proc.command[i]);
        if (!current || current === proc.command[i]) continue;
        if (!existsSync(proc.command[i])) gone = true;
        proc.command[i] = current;
        repointed.push(proc.name);
      }
    }
    if (repointed.length > 0) {
      changes.push(
        `${did("point", "pointed")} ${list(repointed)} at this copy of the kit${gone ? ", whose own copy is gone" : ""}`,
      );
      if (gone) onlyAtNextStart = false; // that process is already dead or dying
    }

    if (changes.length === 0) continue;

    const state = readJson(join(runDir, "state.json"));
    const up = state !== null && alive(state.pid);
    const needsRestart = up && !onlyAtNextStart;
    if (!check) {
      const written = join(runDir, "spec.json.new");
      writeFileSync(written, JSON.stringify({ ...spec, processes }, null, 2) + "\n", { mode: 0o600 });
      renameSync(written, specPath);
      chmodSync(specPath, 0o600); // it holds the run's connector token
    }

    let tail;
    if (!up) tail = "It takes effect when the run next starts.";
    else if (!needsRestart) tail = "The processes that are up keep the copy they started with, which still works; the next restart picks this one up.";
    else if (restart && !check) tail = restartRun(runDir) ? "Restarted it." : "Restarting it failed; see the run dir's daemon.log.";
    else {
      tail = "Restart it to pick this up.";
      pending.push({ label: `${codebase}/${name}`, runDir, cost: interruption(name) });
    }
    repaired.push(`${codebase}/${name}: ${changes.join(", and ")}. ${tail}`);
  }
}

for (const line of repaired) console.log(line);
for (const line of skipped) console.log(line);
if (repaired.length === 0) {
  console.log(
    skipped.length === 0
      ? "Every run already matches this copy of the kit; nothing needed repairing."
      : "Nothing else needed repairing.",
  );
}
if (pending.length > 0) {
  console.log("");
  console.log(`Waiting on a restart: ${list(pending.map((p) => p.label))}.`);
  for (const { label, cost } of pending) console.log(`  ${label}: ${cost}`);
  console.log(check ? "Run this without --check, then again with --restart." : "Run this again with --restart when the person is ready.");
}
if (check) console.log("\nNothing was written (--check).");

// Which agent's courier this is. Read per courier, from what the
// courier itself holds: the Codex thread and the Codex fallback
// launcher are written only on Codex, the Claude Code launcher
// template only there, and failing both, the copy of the kit the
// spec was written from sits inside the harness's own plugin cache.
// A courier set up from a bare checkout says nothing, and --harness
// is the answer for that one.
function courierHarness(runDir, spec) {
  const config = readJson(join(runDir, "courier.json")) ?? {};
  if (config.codexThread || config.codexAgent) return "codex";
  if (config.agent && Object.keys(config.agent).length > 0) return "claude";
  for (const proc of spec.processes) {
    for (const arg of proc.command) {
      if (typeof arg !== "string" || !arg.endsWith(".mjs")) continue;
      if (arg.includes("/.codex/")) return "codex";
      if (arg.includes("/.claude/")) return "claude";
      if (arg.includes("/.cursor/")) return "cursor";
    }
  }
  return told;
}

// This kit's copy of the tool an argument names, or null when the
// argument is not one of the kit's tools. Matched on the path from
// `tools/` onward, so a tool in a subfolder keeps its place, and
// only when this kit actually carries that file: a spec naming
// something this version dropped is left alone rather than pointed
// at a file that is not there.
function kitScript(arg) {
  if (typeof arg !== "string" || !arg.endsWith(".mjs")) return null;
  const at = arg.lastIndexOf("/tools/");
  if (at === -1) return null;
  const candidate = join(kit, arg.slice(at + 1));
  return existsSync(candidate) ? candidate : null;
}

// Stop, wait for the supervisor to let go of its children, start.
// `start` refuses while the old daemon is alive, and the daemon
// removes state.json as it goes, so that file is the handover.
function restartRun(runDir) {
  spawnSync(process.execPath, [supervise, "stop", runDir], { encoding: "utf8" });
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const state = readJson(join(runDir, "state.json"));
    if (state === null || !alive(state.pid)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return spawnSync(process.execPath, [supervise, "start", runDir], { encoding: "utf8" }).status === 0;
}

// What restarting this run costs the person, in their words. The
// skill asks before any of it happens, and these are the sentences
// it asks with.
function interruption(name) {
  if (name === "courier") return "the site's commands pause for a few seconds while it comes back.";
  if (name === "library") return "the library's public address is down for a few seconds.";
  return "its public address is down for a few seconds, and the Frame shows the last published build meanwhile.";
}

function list(values) {
  const unique = [...new Set(values)];
  if (unique.length <= 1) return unique.join("");
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}
