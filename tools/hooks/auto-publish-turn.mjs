#!/usr/bin/env node
/**
 * End-of-turn hook (Claude Code and Codex Stop, Cursor stop): start
 * tools/auto-publish.mjs detached, so every served prototype and library
 * the turn changed is built and published while the agent goes on. The
 * hook itself returns at once. Silent and fail soft; Cursor reads JSON
 * back, so it gets `{}`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cursor = false;
try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  cursor = "cursor_version" in input || "conversation_id" in input;
} catch {}
try {
  const tool = fileURLToPath(new URL("../auto-publish.mjs", import.meta.url));
  spawn(process.execPath, [tool], { detached: true, stdio: "ignore" }).unref();
} catch {}
if (cursor) process.stdout.write("{}\n");
process.exit(0);
