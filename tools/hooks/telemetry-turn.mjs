#!/usr/bin/env node
/**
 * End-of-turn hook (Claude Code and Codex Stop, Cursor stop): wake this
 * session's debug reporter so the turn just finished is sent, starting
 * the reporter first if it is not running (a session opened before Proto
 * was linked, or one whose reporter quit on idle). The reporter debounces
 * close turns and sends nothing when nothing changed. Silent and fail
 * soft; Cursor reads JSON back, so it gets `{}`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { codexRollout, sessionAt, TELEMETRY_DIR } from "../debug-report.mjs";
import { ensureReporter } from "../telemetry.mjs";

let cursor = false;
try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  cursor = "cursor_version" in input || "conversation_id" in input;
  const id = input.session_id ?? input.conversation_id ?? input.sessionId ?? input.thread_id;
  const path = input.transcript_path ?? process.env.CURSOR_TRANSCRIPT_PATH ?? (id ? codexRollout(id) : null);
  if (id && path) {
    const session = { ...sessionAt(path, String(id)), ...(cursor ? { harness: "cursor" } : {}) };
    await ensureReporter(session, `${input.hook_event_name ?? "stop"} turn`);
    process.kill(Number(readFileSync(join(TELEMETRY_DIR, `${session.id}.pid`), "utf8")), "SIGUSR2");
  }
} catch {}
if (cursor) process.stdout.write("{}\n");
process.exit(0);
