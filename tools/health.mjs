#!/usr/bin/env node
/**
 * Read-only health check across ~/.proto — the proto plugin's
 * session-start hook. First, which kit this session runs and which site
 * it talks to; then one line per codebase with serving health and its
 * recovery command when
 * something's down. Never restarts anything, never errors: a machine
 * with no ~/.proto prints nothing and exits 0.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./mcp-call.mjs";
import { isLegacyCourierRun } from "./legacy-runs.mjs";

const root = join(process.env.HOME ?? "", ".proto");
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

let codebases;
try {
  codebases = readdirSync(root, { withFileTypes: true }).filter(
    (e) => e.isDirectory() && e.name !== "chrome",
  );
} catch {
  process.exit(0); // no ~/.proto: not set up, nothing to say
}

// Which kit this is: a plugin installed from GitHub runs from a cache
// folder named after its version (…/proto/<version>); one installed from
// a local marketplace runs straight from that checkout, so its version is
// the checkout's branch and commit, and any edits not yet committed. The
// site is config.json's, or PROTO_APP's.
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args) => execFileSync("git", ["-C", kit, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
let version = kit;
try {
  const edits = git("status", "--porcelain").length > 0 ? ", with uncommitted edits" : "";
  version = `${kit} (${git("rev-parse", "--abbrev-ref", "HEAD")} at ${git("rev-parse", "--short", "HEAD")}${edits})`;
} catch {}
let site = "not linked";
try {
  site = readConfig().app;
} catch {}
console.log(`proto kit ${version}, site ${site}`);

for (const codebase of codebases) {
  const runRoot = join(root, codebase.name, "run");
  let runDirs = [];
  try {
    runDirs = readdirSync(runRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}
  if (runDirs.length === 0) continue; // nothing ever served: stay quiet

  let servingUp = 0;
  let servingTotal = 0;
  for (const dir of runDirs) {
    if (isLegacyCourierRun(join(runRoot, dir.name))) continue;
    const state = readJson(join(runRoot, dir.name, "state.json"));
    const up =
      state !== null &&
      alive(state.pid) &&
      Object.values(state.processes).every((p) => alive(p.pid));
    servingTotal += 1;
    if (up) servingUp += 1; else {
      servingTotal += 1;
      if (up) servingUp += 1;
    }
  }

  const parts = [];
  if (servingTotal > 0) {
    if (servingUp === servingTotal) parts.push("serving");
    else parts.push(`${servingUp}/${servingTotal} serving`);
  }
  const allGood =
    servingTotal === 0 || servingUp === servingTotal;
  let line = `${codebase.name}: ${parts.join(", ")}`;
  if (!allGood) line += ": run /proto:serve to bring it back";
  console.log(line);
}
