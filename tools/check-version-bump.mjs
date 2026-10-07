#!/usr/bin/env node
/**
 * A push that changes the kit must change the Codex version too: Codex
 * installs the plugin into a folder named by the `version` in
 * .codex-plugin/plugin.json and keeps the copy it already has, so a
 * change under an old version never reaches a laptop (AGENTS.md). The
 * release registration then fails with "version already belongs to
 * another commit", which nobody reads. This fails the push's check
 * with a sentence that says what to do.
 *
 * Usage (CI): node tools/check-version-bump.mjs <base commit> [<head commit>]
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MANIFEST = ".codex-plugin/plugin.json";
const VERSION = /^0\.1\.0\+codex\.(\d{14})$/;

/** What is wrong with going from `before` to `after`, or null. */
export function versionProblem({ before, after, changed }) {
  if (changed.length === 0) return null;
  const now = VERSION.exec(after ?? "");
  if (!now) return `${MANIFEST} version "${after}" is not 0.1.0+codex.<14-digit UTC time>`;
  if (after === before) {
    return `the kit changed (${changed.slice(0, 3).join(", ")}${changed.length > 3 ? ", …" : ""}) but ${MANIFEST} still says ${after}; Codex laptops will never install it. Set it to the current UTC time (see AGENTS.md) and push again.`;
  }
  const was = VERSION.exec(before ?? "");
  if (was && now[1] <= was[1]) return `${MANIFEST} version went from ${before} to ${after}; it must move forward.`;
  return null;
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function versionAt(commit) {
  try {
    return JSON.parse(git("show", `${commit}:${MANIFEST}`)).version;
  } catch {
    return null;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [base, head = "HEAD"] = process.argv.slice(2);
  if (!base || /^0+$/.test(base)) {
    console.log("no base commit to compare with; nothing to check");
    process.exit(0);
  }
  const changed = git("diff", "--name-only", base, head).split("\n").filter(Boolean);
  const problem = versionProblem({ before: versionAt(base), after: versionAt(head), changed });
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log(changed.length ? `version ${versionAt(head)} moved forward for ${changed.length} changed file(s)` : "nothing changed");
}
