/**
 * Where each harness keeps a session's transcript on this laptop, read
 * only, for the trace (trace.mjs and its hook):
 *
 *   Claude Code  $CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl, and
 *                everything in <session>/ beside it (subagents/*.jsonl and
 *                their .meta.json)
 *   Codex        $CODEX_HOME/sessions/**\/rollout-*-<thread>.jsonl, and every
 *                rollout whose first record names that thread (its
 *                subagents), and theirs in turn
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex");
const CODEX_SESSIONS = join(CODEX_HOME, "sessions");

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function walkFiles(dir, keep = () => true) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (keep(p, true)) walk(p);
      } else if (e.isFile() && keep(p, false)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function firstLine(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const end = text.indexOf("\n");
    return end === -1 ? text : text.slice(0, end);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** A session named by its transcript's path, as hooks give it. */
export function sessionAt(path, id) {
  const harness = path.startsWith(CODEX_SESSIONS) ? "codex" : "claude-code";
  const fromName = harness === "codex" ? /-([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] : basename(path, ".jsonl");
  return { path, id: id || fromName, harness };
}

/** A Codex session by its thread id, for a hook that gives no path. */
export function codexRollout(id) {
  return walkFiles(CODEX_SESSIONS, (p, isDir) => isDir || p.endsWith(`${id}.jsonl`))[0] ?? null;
}

export function claudeFiles(session) {
  const files = [{ name: "session.jsonl", path: session.path }];
  const beside = join(dirname(session.path), session.id);
  for (const path of walkFiles(beside)) files.push({ name: `session/${relative(beside, path)}`, path });
  return files;
}

/** The thread's rollout, then every rollout whose opening record names a
 *  thread already collected: its subagents, and theirs. Matching the id
 *  anywhere in that record holds whatever Codex calls the parent field. */
export function codexFiles(session) {
  let started = 0;
  try {
    started = statSync(session.path).birthtimeMs || 0;
  } catch {}
  const rollouts = walkFiles(CODEX_SESSIONS, (p, isDir) => isDir || (/rollout-.*\.jsonl$/.test(p) && mtimeOf(p) >= started))
    .filter((p) => p !== session.path)
    .map((path) => ({ path, head: firstLine(path), id: /-([0-9a-f-]{36})\.jsonl$/.exec(path)?.[1] }));
  const files = [{ name: "session.jsonl", path: session.path }];
  const known = [session.id];
  for (let i = 0; i < known.length; i++) {
    for (const r of rollouts) {
      if (r.id && !known.includes(r.id) && r.head.includes(known[i])) {
        known.push(r.id);
        files.push({ name: `subagents/${basename(r.path)}`, path: r.path });
      }
    }
  }
  return files;
}

/** Whether a transcript shows the session used Proto. */
export function usesProto(text) {
  return /proto:[a-z-]+|mcp__plugin_proto_|\/\.proto\/|proto-kit[^"\s]*\/skills\/|plugins\/local\/proto\/(tools|skills)\//.test(text);
}
