#!/usr/bin/env node
/**
 * Cursor sessionStart hook: the same health check as the Claude Code
 * and Codex session-start hooks (tools/health.mjs), in Cursor's shape.
 * Cursor hooks answer with JSON on stdout; text is added to the
 * conversation through `additional_context`. Runs health.mjs as it is,
 * wraps its lines, and answers `{}` when there is nothing to say.
 * Fail soft: any problem in the hook itself is `{}`, never an error.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let context = "";
try {
  const health = fileURLToPath(new URL("../health.mjs", import.meta.url));
  const res = spawnSync(process.execPath, [health], { encoding: "utf8", timeout: 8000 });
  // health.mjs names the fix as Claude Code's command; in Cursor the
  // same skill is picked from the chat's "/" menu.
  context = (res.stdout ?? "").trim().replaceAll("/proto:serve", "the Proto serve skill");
} catch {}

process.stdout.write(
  JSON.stringify(context ? { additional_context: `Proto: ${context}` } : {}) + "\n",
);
process.exit(0);
