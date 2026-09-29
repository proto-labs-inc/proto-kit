#!/usr/bin/env node
/**
 * Read-only health check across ~/.proto — the proto plugin's
 * session-start hook. First, which kit this session runs and which site
 * it talks to; then one line per codebase: what's serving and whether
 * the courier is listening, with the one command that fixes it when
 * something's down. Never restarts anything, never errors: a machine
 * with no ~/.proto prints nothing and exits 0.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./mcp-call.mjs";

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

// The kit's folder names its version: an installed plugin lives in a
// cache folder named after it (…/proto/<version>), a kit run from a
// checkout in that checkout. The site is config.json's, or PROTO_APP's.
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
let site = "not linked";
try {
  site = readConfig().app;
} catch {}
console.log(`proto kit ${kit}, site ${site}`);

for (const codebase of codebases) {
  const runRoot = join(root, codebase.name, "run");
  let runDirs = [];
  try {
    runDirs = readdirSync(runRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {}
  if (runDirs.length === 0) continue; // nothing ever served: stay quiet

  let servingUp = 0;
  let servingTotal = 0;
  let courier = "absent"; // "absent" (no courier run dir) | "listening" | "offline"
  for (const dir of runDirs) {
    const state = readJson(join(runRoot, dir.name, "state.json"));
    const up =
      state !== null &&
      alive(state.pid) &&
      Object.values(state.processes).every((p) => alive(p.pid));
    if (dir.name === "courier") {
      if (up) courier = "listening";
      else courier = "offline";
    } else {
      servingTotal += 1;
      if (up) servingUp += 1;
    }
  }

  const parts = [];
  if (servingTotal > 0) {
    if (servingUp === servingTotal) parts.push("serving");
    else parts.push(`${servingUp}/${servingTotal} serving`);
  }
  if (courier === "listening") parts.push("courier listening");
  if (courier === "offline") parts.push("courier offline");
  const allGood =
    (servingTotal === 0 || servingUp === servingTotal) && courier !== "offline";
  let line = `${codebase.name}: ${parts.join(", ")}`;
  if (!allGood) line += ": run /proto:serve to bring it back";
  console.log(line);
}
