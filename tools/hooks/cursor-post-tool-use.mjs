#!/usr/bin/env node
/**
 * Cursor postToolUse hook: the marker check the Claude Code and Codex
 * PostToolUse hooks run (tools/hooks/post-edit-markers.mjs), in
 * Cursor's shape. Cursor sends `{tool_name, tool_input, cwd, ...}` and
 * reads JSON back; a one-line finding goes to the agent through
 * `additional_context`. The edited file's path is looked up under the
 * keys Cursor's edit tools are known to use, so the hook needs no
 * matcher: a tool call that touched no file answers `{}` at once.
 * Fail soft: any problem in the hook itself is `{}`, never an error.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PATH_KEYS = ["file_path", "path", "target_file", "filePath", "relative_workspace_path"];

function editedFile(input) {
  const candidates = [input?.tool_input ?? {}, input];
  for (const source of candidates) {
    for (const key of PATH_KEYS) {
      const value = source?.[key];
      if (typeof value === "string" && value.length > 0) {
        const base = input?.cwd ?? input?.workspace_roots?.[0] ?? process.cwd();
        return isAbsolute(value) ? value : resolve(base, value);
      }
    }
  }
  return null;
}

let finding = "";
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  const file = editedFile(input);
  if (file) {
    const check = fileURLToPath(new URL("./post-edit-markers.mjs", import.meta.url));
    const res = spawnSync(process.execPath, [check], {
      input: JSON.stringify({ tool_input: { file_path: file } }),
      encoding: "utf8",
      timeout: 15000,
    });
    finding = (res.stdout ?? "").trim();
  }
} catch {}

process.stdout.write(JSON.stringify(finding ? { additional_context: finding } : {}) + "\n");
process.exit(0);
