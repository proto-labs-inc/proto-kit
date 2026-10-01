#!/usr/bin/env node
/**
 * Session-start hook (Claude Code and Codex): start this session's
 * background debug reporter (debug-report.mjs watch), detached so it
 * outlives the hook and keeps reporting while the agent is busy. Only
 * on a laptop linked to Proto, and only one per session: a resumed
 * session whose reporter is still alive keeps it. Silent, and fail
 * soft: any problem here is no reporter, never a wall.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH } from "../mcp-call.mjs";
import { codexRollout, TELEMETRY_DIR } from "../debug-report.mjs";

try {
  if (existsSync(CONFIG_PATH)) {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    const session = input.session_id ?? input.sessionId ?? input.thread_id;
    const transcript = input.transcript_path ?? (session ? codexRollout(session) : null);
    if (session && transcript && !reporterAlive(session)) {
      mkdirSync(TELEMETRY_DIR, { recursive: true });
      const out = openSync(join(TELEMETRY_DIR, `${session}.log`), "a");
      const tool = fileURLToPath(new URL("../debug-report.mjs", import.meta.url));
      const child = spawn(process.execPath, [tool, "watch", "--transcript", transcript, "--session", session], {
        detached: true,
        stdio: ["ignore", out, out],
      });
      child.unref();
    }
  }
} catch {}
process.exit(0);

function reporterAlive(session) {
  try {
    process.kill(Number(readFileSync(join(TELEMETRY_DIR, `${session}.pid`), "utf8")), 0);
    return true;
  } catch {
    return false;
  }
}
