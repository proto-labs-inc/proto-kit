#!/usr/bin/env node
/**
 * The Codex wake adapter — the nobody-at-the-keyboard fallback. On
 * Claude the idle path is a resumed session with a Monitor watch; on
 * Codex nothing wakes an idle agent, so this daemon consumes the feed
 * itself: for each command it resumes the listening session's saved
 * conversation (`codex exec resume <session-id>`), delivering the
 * command as the next message, and commits the offset only when the
 * run exits cleanly — the same at-least-once contract as feed-tail.
 * The interactive path (the user's open session polling feed-tail in
 * a background terminal) is the normal mode; run this under
 * supervise.mjs only for unattended operation.
 *
 * Usage: node feed-drive.mjs <run-dir>   (reads <run-dir>/courier.json)
 *
 * courier.json's codexAgent block:
 *   "codexAgent": { "bin": "codex",
 *                   "args": ["exec", "--json"],
 *                   "resumeArgs": ["resume", "{sessionId}"],
 *                   "sessionIdKeys": ["session_id", "thread_id", "id"],
 *                   "instruction": "Courier command (act per the proto listen skill): {command}" }
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node feed-drive.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
const agent = config.codexAgent;
const feed = join(runDir, "commands.jsonl");
const offsetPath = join(runDir, "offset.json");
const sessionPath = join(runDir, "codex-session.json");

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

// Find a session id anywhere in a JSONL event stream — Codex event
// shapes vary by version, so match on configured key names.
function captureSessionId(stdout, keys) {
  for (const line of stdout.split("\n")) {
    try {
      const event = JSON.parse(line);
      const walk = (o) => {
        if (!o || typeof o !== "object") return null;
        for (const [k, v] of Object.entries(o)) {
          if (keys.includes(k) && typeof v === "string" && v.length > 0) return v;
          const nested = walk(v);
          if (nested) return nested;
        }
        return null;
      };
      const found = walk(event);
      if (found) return found;
    } catch {}
  }
  return null;
}

function pending() {
  let offset = readJson(offsetPath, { offset: 0 }).offset ?? 0;
  let size;
  try {
    size = statSync(feed).size;
  } catch {
    return [];
  }
  if (size < offset) offset = 0;
  if (size === offset) return [];
  const fd = openSync(feed, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  const text = buf.toString("utf8");
  // Only complete lines; a partial trailing line waits for the next pass.
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const out = [];
  let consumed = offset;
  for (const line of complete.split("\n").slice(0, -1)) {
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length > 0) out.push({ offset: consumed, line });
  }
  return out;
}

function driveOne({ offset, line }) {
  const session = readJson(sessionPath, { sessionId: null });
  const instruction = agent.instruction.replaceAll("{command}", line);
  const argv = session.sessionId
    ? [...agent.args.slice(0, 1), ...agent.resumeArgs.map((a) => a.replaceAll("{sessionId}", session.sessionId)), ...agent.args.slice(1), instruction]
    : [...agent.args, instruction];
  console.log(`drive: ${session.sessionId ? `resume ${session.sessionId}` : "fresh session"} <- ${line.slice(0, 80)}`);
  const res = spawnSync(agent.bin, argv, { cwd: config.productDir ?? runDir, encoding: "utf8" });
  const sid = captureSessionId(res.stdout ?? "", agent.sessionIdKeys ?? ["session_id", "thread_id", "id"]);
  if (sid && sid !== session.sessionId) writeFileSync(sessionPath, JSON.stringify({ sessionId: sid }));
  if (res.status === 0) {
    writeFileSync(offsetPath, JSON.stringify({ offset }));
    console.log(`drive: done, offset ${offset}`);
    return true;
  }
  if (session.sessionId && !res.stdout?.trim()) {
    // Dead session: note the break, retry fresh next pass (offset uncommitted).
    console.log("drive: resume produced nothing; clearing session for a fresh retry");
    writeFileSync(sessionPath, JSON.stringify({ sessionId: null, brokeAt: new Date().toISOString() }));
  } else {
    console.log(`drive: run FAILED (exit ${res.status}); will retry`);
  }
  return false;
}

function tick() {
  for (const item of pending()) {
    if (!driveOne(item)) break; // stop on failure; retry same command next tick
  }
}
tick();
setInterval(tick, 3000);
