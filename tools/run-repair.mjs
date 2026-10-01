/** Serving-run spec maintenance. Removed command listeners are never repaired or restarted. */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isLegacyCourierRun } from "./legacy-runs.mjs";

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

/** Repoint serving scripts and remove obsolete environment settings. */
export function repairProcesses({ name, spec, kit, runDir }) {
  const processes = spec.processes.map((proc) => ({ ...proc, command: [...proc.command] }));
  const changes = [];
  let missing = false;
  if (name === "courier" || isLegacyCourierRun(runDir, spec)) return { processes, changes, missing, retired: true };

  // The copy of the kit each process runs from.
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

  return { processes, changes, missing };
}

/** One change in words. `did(verb, past)` picks "would add" or "added". */
export function describeChange(change, did) {
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
  if (isLegacyCourierRun(runDir)) return false;
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
