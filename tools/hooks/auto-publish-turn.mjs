#!/usr/bin/env node
/**
 * End-of-turn hook (Claude Code and Codex Stop, Cursor stop): start
 * tools/auto-publish.mjs detached for this session, so every prototype and
 * library the turn changed is built and published while the agent goes on.
 * The hook itself returns at once. Silent and fail soft; Cursor reads JSON
 * back, so it gets `{}`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cursor = false;
try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  cursor = "cursor_version" in input || "conversation_id" in input;
  const session = input.session_id ?? input.conversation_id ?? input.sessionId ?? input.thread_id;
  if (session) {
    const tool = fileURLToPath(new URL("../auto-publish.mjs", import.meta.url));
    spawn(process.execPath, [tool, String(session)], { detached: true, stdio: "ignore" }).unref();
  }
} catch {}
if (cursor) process.stdout.write("{}\n");
process.exit(0);
