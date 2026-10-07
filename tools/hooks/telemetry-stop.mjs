#!/usr/bin/env node
/**
 * Session-end hook (Claude Code, Codex, Cursor): tell this session's background debug
 * reporter the session is over. It sends a last snapshot and exits on
 * its own; it is detached, so it finishes after the agent has gone.
 * Silent, and fail soft.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TELEMETRY_DIR } from "../debug-report.mjs";

let cursor = false;
try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  cursor = "cursor_version" in input || "conversation_id" in input;
  const session = input.session_id ?? input.conversation_id ?? input.sessionId;
  if (session) process.kill(Number(readFileSync(join(TELEMETRY_DIR, `${session}.pid`), "utf8")), "SIGTERM");
} catch {}
if (cursor) process.stdout.write("{}\n");
process.exit(0);
