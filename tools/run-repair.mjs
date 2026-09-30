/**
 * The rules that bring one run's spec up to what this copy of the kit
 * expects, shared by the two tools that apply them: repair-runs.mjs,
 * which walks every run on the laptop after an update, and
 * courier-up.mjs, which applies them to its own courier before starting
 * it, so the one "run /proto:listen" the site offers also brings a
 * courier set up by an older kit onto the relay.
 *
 * Pure apart from reading files: nothing here writes a spec or touches a
 * process except restartRun, which the callers use only when they mean
 * to. The words each change is reported in live here too, so both tools
 * say the same thing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A spec.json the supervisor can run: a list of named commands. */
export function readableSpec(spec) {
  return (
    spec !== null &&
    Array.isArray(spec?.processes) &&
    spec.processes.every((p) => typeof p?.name === "string" && Array.isArray(p.command))
  );
}

// Which agent's courier this is. Read per courier, from what the
// courier itself holds: the Codex thread and the Codex fallback
// launcher are written only on Codex, the Claude Code launcher
// template only there, and failing both, the copy of the kit the
// spec was written from sits inside the harness's own plugin cache.
// A courier set up from a bare checkout says nothing, and `told`
// (repair-runs' --harness, courier-up's --codex) is the answer for
// that one.
export function courierHarness(runDir, spec, told = null) {
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
export function kitScript(arg, kit) {
  if (typeof arg !== "string" || !arg.endsWith(".mjs")) return null;
  const at = arg.lastIndexOf("/tools/");
  if (at === -1) return null;
  const candidate = join(kit, arg.slice(at + 1));
  return existsSync(candidate) ? candidate : null;
}

/**
 * One run's processes as this kit wants them. `name` is the run dir's
 * name ("courier" gets rule 1), `harness` the courier's agent or null
 * when nothing says. Returns the new processes (the spec's are not
 * touched), the changes made, whether any of them leaves a process this
 * version needs not running at all (`missing`), and `unsure` when a
 * courier's harness could not be told.
 *
 * Changes are { kind: "add-wake" | "remove-wake" | "remove-tunnel" },
 * { kind: "repoint", names, gone } or { kind: "drop-packages-env", names };
 * describeChange words them.
 */
export function repairProcesses({ name, spec, kit, runDir, harness }) {
  const processes = spec.processes.map((proc) => ({ ...proc, command: [...proc.command] }));
  const changes = [];
  let missing = false;
  let unsure = false;

  // Rule 1: the courier's processes, per this courier's harness.
  if (name === "courier") {
    const wake = processes.findIndex((p) => p.name === "codex-wake");
    if (harness === "codex" && wake === -1) {
      processes.push({ name: "codex-wake", command: ["node", join(kit, "tools", "feed-queue.mjs"), runDir] });
      changes.push({ kind: "add-wake" });
      missing = true;
    } else if (harness && harness !== "codex" && wake !== -1) {
      processes.splice(wake, 1);
      changes.push({ kind: "remove-wake" });
      missing = true;
    } else if (!harness && wake === -1) {
      unsure = true;
    }
    // Commands arrive through the relay now: a courier's tunnel carries nothing.
    const tunnel = processes.findIndex((p) => p.name === "tunnel");
    if (tunnel !== -1) {
      processes.splice(tunnel, 1);
      changes.push({ kind: "remove-tunnel" });
      missing = true;
    }
  }

  // Rule 2: the copy of the kit each process runs from.
  const repointed = [];
  let gone = false;
  for (const proc of processes) {
    for (let i = 0; i < proc.command.length; i += 1) {
      const current = kitScript(proc.command[i], kit);
      if (!current || current === proc.command[i]) continue;
      if (!existsSync(proc.command[i])) gone = true;
      proc.command[i] = current;
      repointed.push(proc.name);
    }
  }
  if (repointed.length > 0) {
    changes.push({ kind: "repoint", names: repointed, gone });
    if (gone) missing = true; // that process is already dead or dying into nothing
  }

  // Rule 3: the rig comes from npm, so no process needs PROTO_PACKAGES.
  const unpacked = [];
  for (const proc of processes) {
    if (!proc.env || !("PROTO_PACKAGES" in proc.env)) continue;
    const { PROTO_PACKAGES: _, ...env } = proc.env;
    proc.env = env;
    unpacked.push(proc.name);
  }
  if (unpacked.length > 0) changes.push({ kind: "drop-packages-env", names: unpacked });

  return { processes, changes, missing, unsure };
}

/** One change in words. `did(verb, past)` picks "would add" or "added". */
export function describeChange(change, did) {
  if (change.kind === "add-wake") return `${did("add", "added")} the Codex wake`;
  if (change.kind === "remove-wake") return `${did("remove", "removed")} the Codex wake, which belongs only to a Codex courier`;
  if (change.kind === "remove-tunnel") return `${did("remove", "removed")} the courier's tunnel, which the relay replaces`;
  if (change.kind === "drop-packages-env") return `${did("drop", "dropped")} PROTO_PACKAGES from ${list(change.names)}, since the rig comes from npm`;
  const whose = change.gone ? ", whose own copy is gone" : "";
  return `${did("point", "pointed")} ${list(change.names)} at this copy of the kit${whose}`;
}

export function list(values) {
  const unique = [...new Set(values)];
  if (unique.length <= 1) return unique.join("");
  return `${unique.slice(0, -1).join(", ")} and ${unique[unique.length - 1]}`;
}

// Stop, wait for the supervisor to let go of its children, start.
// `start` refuses while the old daemon is alive, and the daemon
// removes state.json as it goes, so that file is the handover.
export function restartRun(runDir, kit) {
  const supervise = join(kit, "tools", "supervise.mjs");
  spawnSync(process.execPath, [supervise, "stop", runDir], { encoding: "utf8" });
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const state = readJson(join(runDir, "state.json"));
    if (state === null || !alive(state.pid)) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  return spawnSync(process.execPath, [supervise, "start", runDir], { encoding: "utf8" }).status === 0;
}
