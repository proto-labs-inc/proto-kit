#!/usr/bin/env node
/**
 * PostToolUse hook (Write|Edit): when the edited file sits inside a
 * Proto prototype workspace (~/.proto/<codebase>/prototypes/<slug>/) or
 * library (~/.proto/<codebase>/library/) that is being served, ask for
 * it to be published when the turn ends (<run>/publish.requested, read
 * by tools/auto-publish.mjs). For a prototype, also re-run the marker
 * check on that workspace and say one line — only when something's
 * wrong. Fail soft everywhere: any problem in the hook itself is
 * silence, never a wall.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { protoHome } from "../proto-home.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const file = input?.tool_input?.file_path ?? "";
  const protoRoot = protoHome() + sep;
  if (!file.startsWith(protoRoot)) process.exit(0);
  const rel = file.slice(protoRoot.length).split(sep);
  let run = null;
  if (rel[1] === "prototypes" && rel.length >= 4) run = rel[2];
  else if (rel[1] === "library" && rel.length >= 3) run = "library";
  if (run) {
    const runDir = join(protoRoot, rel[0], "run", run);
    if (existsSync(runDir)) writeFileSync(join(runDir, "publish.requested"), "");
  }
  if (rel[1] !== "prototypes" || rel.length < 4) process.exit(0);
  const workspace = join(protoRoot, rel[0], "prototypes", rel[2]);

  const verify = fileURLToPath(new URL("../verify-markers.mjs", import.meta.url));
  const res = spawnSync(process.execPath, [verify, workspace], { encoding: "utf8" });
  if (res.status !== 0) {
    const firstProblem = (res.stderr || res.stdout || "").trim().split("\n")[0];
    console.log(`markers (${rel[2]}): ${firstProblem}`);
  }
} catch {}
process.exit(0);
