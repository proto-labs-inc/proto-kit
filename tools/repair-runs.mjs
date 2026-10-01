#!/usr/bin/env node
/** Repair library/prototype serving specs. Legacy command listeners are always skipped.
 * Usage: node repair-runs.mjs [<codebase>…] [--check] [--restart]
 */
import { chmodSync, existsSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { alive, describeChange, list, readJson, readableSpec, repairProcesses, restartRun } from "./run-repair.mjs";

import { isLegacyCourierRun } from "./legacy-runs.mjs";
const argv = process.argv.slice(2);
const check = argv.includes("--check");
const restart = argv.includes("--restart");
// Consume the obsolete --harness argument for older update invocations only.
const named = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--harness");

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(process.env.HOME ?? "", ".proto");
const did = (verb, past) => (check ? `would ${verb}` : past);

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
    if (isLegacyCourierRun(runDir, spec)) {
      skipped.push(`${codebase}/${name}: legacy courier run left untouched; preview retirement with node ${join(kit, "tools", "retire-legacy-runs.mjs")} ${runDir}.`);
      continue;
    }
    if (!readableSpec(spec)) {
      if (existsSync(specPath)) skipped.push(`${codebase}/${name}: its spec.json does not read as a run spec; left alone.`);
      continue;
    }

    const repair = repairProcesses({ name, spec, kit, runDir });
    const { processes } = repair;
    const missingHere = repair.missing; // something this version needs is not running at all, not merely out of date
    const changes = repair.changes.map((change) => describeChange(change, did));

    if (changes.length === 0) continue;

    const state = readJson(join(runDir, "state.json"));
    const up = state !== null && alive(state.pid);
    if (!check) {
      const written = join(runDir, "spec.json.new");
      writeFileSync(written, JSON.stringify({ ...spec, processes }, null, 2) + "\n", { mode: 0o600 });
      renameSync(written, specPath);
      chmodSync(specPath, 0o600); // it holds the run's connector token
    }

    // A run that is up was started from the spec as it was, so the
    // rewrite reaches it only through a restart — either because a
    // process this version needs is not running at all, or because
    // the ones that are running came from the copy of the kit this
    // update replaced and go on running its code. The second is the
    // one nothing else on the laptop ever mentions.
    const reason = !up ? null : missingHere ? "missing" : "stale";
    let tail;
    if (!up) tail = "It takes effect when the run next starts.";
    else if (restart && !check) tail = restartRun(runDir, kit) ? "Restarted it." : "Restarting it failed; see the run dir's daemon.log.";
    else {
      tail =
        reason === "missing"
          ? "Restart it to pick this up."
          : "Its processes are still running the copy of the kit they were started from.";
      pending.push({ label: `${codebase}/${name}`, reason, cost: interruption(name) });
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
const missingNow = pending.filter((p) => p.reason === "missing");
const staleNow = pending.filter((p) => p.reason === "stale");
if (missingNow.length > 0) {
  console.log("");
  console.log(`Waiting on a restart: ${list(missingNow.map((p) => p.label))}.`);
  console.log("  A process this version needs is not running there at all until one happens.");
  for (const { label, cost } of missingNow) console.log(`  ${label}: ${cost}`);
}
if (staleNow.length > 0) {
  console.log("");
  console.log(`Still running an older copy of the kit: ${list(staleNow.map((p) => p.label))}.`);
  console.log(
    "  Their specs name this copy now, but the processes that are up were started from the one this update replaced, and they go on running its code — including how it talks to the site — until they restart. Nothing else on this laptop says so.",
  );
  for (const { label, cost } of staleNow) console.log(`  ${label}: ${cost}`);
}
if (pending.length > 0) {
  console.log("");
  console.log(check ? "Run this without --check, then again with --restart." : "Run this again with --restart to apply it.");
}
if (check) console.log("\nNothing was written (--check).");

// What restarting this run costs, for the report when it runs
// without --restart.
function interruption(name) {
  if (name === "library") return "the library's public address is down for a few seconds.";
  return "its public address is down for a few seconds, and the Frame shows the last published build meanwhile.";
}
