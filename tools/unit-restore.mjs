#!/usr/bin/env node
/**
 * A unit's safety net: the component or part exactly as the tools
 * wrote it, kept before the unit's first edit and put back when the
 * unit ends without a match. A fixer that deleted the product's own
 * content to quiet a diff, or left the markup broken, used to leave
 * that behind as the part; now the check that stops the unit restores
 * the folder, so the worst a unit can do is change nothing.
 *
 *   node tools/unit-restore.mjs keep    <folder> --as <slug> --run <dir>
 *   node tools/unit-restore.mjs restore <folder> --as <slug> --run <dir>
 *
 * `keep` copies <folder> to <dir>/before/<slug>/ unless a copy is
 * there already (the first keep is the one that counts: it is the
 * folder before any edit). `restore` replaces <folder> with that copy.
 * tools/explain-diff.mjs keeps (a unit's first step), tools/check.mjs
 * and tools/check-part.mjs restore when they tell the unit to stop.
 *
 * From code: keepFolder({ folder, slug, runDir }) -> { kept, path },
 * restoreFolder({ folder, slug, runDir }) -> { restored, path }.
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the kept copy of `slug` lives under a run or build folder. */
export function keptPath(runDir, slug) {
  return join(runDir, "before", slug);
}

/** Keep the folder as it is now, once: a later keep leaves the first copy alone. */
export function keepFolder({ folder, slug, runDir }) {
  const path = keptPath(runDir, slug);
  if (existsSync(path)) return { kept: false, path };
  if (!existsSync(folder)) return { kept: false, path: null };
  mkdirSync(join(runDir, "before"), { recursive: true });
  cpSync(folder, path, { recursive: true });
  return { kept: true, path };
}

/** Put the kept copy back in place of the folder; nothing happens without a copy. */
export function restoreFolder({ folder, slug, runDir }) {
  const path = keptPath(runDir, slug);
  if (!existsSync(path)) return { restored: false, path: null };
  rmSync(folder, { recursive: true, force: true });
  cpSync(path, folder, { recursive: true });
  return { restored: true, path };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = {};
  const positional = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      options[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else positional.push(args[i]);
  }
  const [command, folder] = positional;
  if (!["keep", "restore"].includes(command) || !folder || !options.as || !options.run) {
    console.error("usage: node tools/unit-restore.mjs keep|restore <folder> --as <slug> --run <dir>");
    process.exit(1);
  }
  const call = { folder, slug: options.as, runDir: options.run };
  const result = command === "keep" ? keepFolder(call) : restoreFolder(call);
  console.log(JSON.stringify({ command, ...result }));
}
