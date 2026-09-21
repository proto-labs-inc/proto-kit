#!/usr/bin/env node
/**
 * PostToolUse hook (Write|Edit): when the edited file sits inside a
 * Proto prototype workspace (~/.proto/<product>/prototypes/<slug>/),
 * re-run the marker check on that workspace and say one line — only
 * when something's wrong. Fail soft everywhere: any problem in the
 * hook itself is silence, never a wall.
 */
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const file = input?.tool_input?.file_path ?? "";
  const protoRoot = join(process.env.HOME ?? "", ".proto") + sep;
  if (!file.startsWith(protoRoot)) process.exit(0);
  const rel = file.slice(protoRoot.length).split(sep);
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
