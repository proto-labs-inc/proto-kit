/** Read-only Codex transcript lookup, used only by explicit debug-report collection. */
import { openSync, readSync, closeSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const SESSIONS = join(CODEX_HOME, "sessions");
// The token was printed seconds ago, so only just-written rollouts can
// hold it, and only near their end. Both bounds keep the scan cheap
// against a sessions tree of thousands of multi-megabyte transcripts.
const FRESH_MS = 15 * 60 * 1000;
const TAIL_BYTES = 1 << 20;

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
