#!/usr/bin/env node
/**
 * Which live Codex thread is this session? — and the shared Codex
 * daemon facts the courier's Codex delivery stands on.
 *
 * Codex has no push wake, so on Codex the courier delivers commands by
 * QUEUEING them into the session the person is actually looking at
 * (`codex queue --thread <id>`), which needs that thread's id. A
 * session cannot read its own id from its environment (only CODEX_HOME
 * and CODEX_APP_TOOLS_PIPE_PATH are set), and it must not be guessed
 * from the newest lock file: sub-agents hold locks too, and the user
 * runs several things at once.
 *
 * So the session identifies itself by a token it chose. The listen
 * skill invokes this tool with a literal random token; that command
 * line lands in THIS thread's transcript on disk before the tool runs
 * (verified 2026-09-28: the rollout's custom_tool_call record is
 * written when the model's turn item arrives, ahead of execution and
 * of its output record). Exactly one rollout file contains the token,
 * and its thread id is in its filename. Zero matches or two are an
 * error, never a guess.
 *
 * Usage:
 *   node codex-thread.mjs identify <run-dir> --token <token> [--timeout <s>]
 *       Find this thread by the token and record it in courier.json.
 *   node codex-thread.mjs status <run-dir>
 *       Print the recorded thread and whether its session is still open.
 *
 * Recorded in <run-dir>/courier.json beside the port and secret:
 *   "codexThread": { "id": "<uuid>", "recordedAt": "<iso>", "harness": "codex" }
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const LOCKS = join(CODEX_HOME, "thread-writer-locks");
const SESSIONS = join(CODEX_HOME, "sessions");
// The token was printed seconds ago, so only just-written rollouts can
// hold it, and only near their end. Both bounds keep the scan cheap
// against a sessions tree of thousands of multi-megabyte transcripts.
const FRESH_MS = 15 * 60 * 1000;
const TAIL_BYTES = 1 << 20;

/**
 * The daemon's own managed Codex binary — the one that can queue into
 * a live thread. `codex` on PATH is whatever the user's version
 * manager points at and may be older, so always resolve the path from
 * the daemon rather than hardcoding or trusting PATH.
 */
export const MANAGED_PATH = join(CODEX_HOME, "packages", "app-server-daemon", "current", "bin", "codex");

export function managedCodex() {
  // Ask over PATH first, then the daemon's own binary: under the
  // supervisor PATH may miss a version manager's shim, and an older
  // `codex` on PATH may not know this subcommand at all.
  let raw;
  for (const bin of ["codex", MANAGED_PATH]) {
    try {
      raw = execFileSync(bin, ["app-server", "daemon", "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      break;
    } catch {}
  }
  if (!raw) {
    throw new Error("Codex isn't running its background service on this laptop, so the courier can't reach your session. Open the Codex desktop app and try again.");
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new Error("Codex's background service answered in a form this version of Proto doesn't understand.");
  }
  if (info.status !== "running" || !info.managedCodexPath) {
    throw new Error("Codex's background service isn't running, so the courier can't reach your session. Open the Codex desktop app and try again.");
  }
  return { bin: info.managedCodexPath, version: info.managedCodexVersion ?? null, socketPath: info.socketPath ?? null };
}

/**
 * Is this thread's session still open? A live thread holds a writer
 * lock; a closed one does not. This is the ONLY reliable liveness
 * signal: `codex queue` against a thread whose session was closed
 * still exits 0 (verified 2026-09-28) — the message is appended to the
 * rollout and nobody ever reads it. Checking the lock first is what
 * keeps a command from being swallowed by a window the person shut.
 */
export function threadIsLive(id) {
  return existsSync(join(LOCKS, `${id}.lock`));
}

function rolloutFiles() {
  const out = [];
  const cutoff = Date.now() - FRESH_MS;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.startsWith("rollout-") && e.name.endsWith(".jsonl")) {
        try {
          const st = statSync(p);
          if (st.mtimeMs >= cutoff) out.push({ path: p, name: e.name, size: st.size });
        } catch {}
      }
    }
  };
  walk(SESSIONS);
  return out;
}

function tailContains(file, token) {
  const start = Math.max(0, file.size - TAIL_BYTES);
  let fd;
  try {
    fd = openSync(file.path, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(file.size - start);
    if (buf.length === 0) return false;
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8").includes(token);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

// rollout-<timestamp>-<thread-uuid>.jsonl
const THREAD_IN_NAME = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

/** Every recent rollout whose transcript contains the token, with its
 *  thread id: { path, id }. */
export function rolloutsHolding(token) {
  const found = [];
  for (const f of rolloutFiles()) {
    const m = THREAD_IN_NAME.exec(f.name);
    if (!m) continue;
    if (tailContains(f, token)) found.push({ path: f.path, id: m[1] });
  }
  return found;
}

/** Every live thread whose recent transcript contains the token. */
export function threadsHolding(token) {
  return [...new Set(rolloutsHolding(token).map((r) => r.id))];
}

export function readCourier(runDir) {
  return JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
}

/** Record the thread beside the port and secret, keeping the file 600. */
export function recordThread(runDir, id) {
  const path = join(runDir, "courier.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.codexThread = { id, recordedAt: new Date().toISOString(), harness: "codex" };
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(path, 0o600);
  return config.codexThread;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function identify(runDir, token, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = threadsHolding(token);
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new Error(`That token turned up in ${found.length} Codex transcripts, so Proto can't tell which session is yours. Try again with a fresh token.`);
    }
    if (Date.now() >= deadline) {
      throw new Error("Proto couldn't find this Codex session's transcript. Print the token in this session first, then run this again with the same token.");
    }
    sleep(500);
  }
}

// Run directly, not imported. Compare real paths: on macOS /tmp is a
// symlink, so a raw string compare of argv[1] against import.meta.url
// silently makes the CLI a no-op.
const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const [command, dirArg, ...rest] = process.argv.slice(2);
  const runDir = resolve(dirArg ?? "");
  const flag = (name) => {
    const i = rest.indexOf(`--${name}`);
    return i === -1 ? undefined : rest[i + 1];
  };
  try {
    if (command === "identify" && dirArg) {
      const token = flag("token");
      if (!token) throw new Error("usage: node codex-thread.mjs identify <run-dir> --token <token>");
      const timeout = Number(flag("timeout") ?? 20) * 1000;
      const id = identify(runDir, token, timeout);
      const record = recordThread(runDir, id);
      console.log(JSON.stringify({ ...record, live: threadIsLive(id) }));
    } else if (command === "status" && dirArg) {
      const record = readCourier(runDir).codexThread ?? null;
      console.log(JSON.stringify(record ? { ...record, live: threadIsLive(record.id) } : { recorded: false }));
    } else {
      console.error("usage: node codex-thread.mjs identify <run-dir> --token <token> [--timeout <s>]\n       node codex-thread.mjs status <run-dir>");
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
