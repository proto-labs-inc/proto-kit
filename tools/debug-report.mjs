#!/usr/bin/env node
/**
 * Debug reports: snapshots of an agent session that uses Proto, sent to
 * the Proto team so they can see exactly how Proto behaved. In alpha this
 * is on by default (people are told on their onboarding call):
 *
 *   - `watch` runs in the background for one session, started by the
 *     session-start hook (hooks/telemetry-start.mjs). Every ten minutes
 *     it sends a snapshot if anything changed; when the session ends
 *     (SIGTERM from the session-end hook) or goes quiet for twenty
 *     minutes it sends a last one and exits. It runs apart from the
 *     agent, so a step that never finishes still gets reported.
 *   - `send` sends one snapshot now, with a headline and a note: the
 *     debug skill, run by the agent when something is worth flagging or
 *     by the user.
 *
 * A snapshot is the session's whole transcript and its subagents'
 * transcripts, the session's whole trace (rebuilt with this kit first:
 * transcript.html and its step pages, report.md, summary.json, flags),
 * and ~/.proto scoped to what the session worked on: the codebases,
 * prototypes and builds its trace names (meta.json), never another
 * prototype's workspace, build or serve folder, another session's trace
 * or log, dependencies, build output, browser profiles, raw screen
 * frames or the laptop's config.json. A session that touched no
 * codebase sends ~/.proto with those same exclusions. The user's own
 * repository is never collected; whatever of it the agent read is in
 * the transcript. Secrets are scrubbed from every text file before it
 * leaves (the laptop's link credentials wherever they appear, tunnel
 * tokens, bearer tokens, JWTs, common API keys); nothing else is
 * changed. Each file is gzipped and PUT to the signed URL
 * begin_debug_report returns, streamed with its exact Content-Length (a
 * chunked body would fail the signature). Each snapshot is its own
 * report.
 *
 * The agent never uploads. `flag` (the debug skill) only records a
 * headline on this laptop and wakes the session's watcher, which sends
 * the snapshot with it; the session's hooks start the watcher and wake
 * it at the end of every turn.
 *
 * Which session `send` belongs to: the skill puts a token it made up on
 * its command line, that command lands in this session's transcript on
 * disk, and the one transcript holding it is this session (using the read-only
 * transcript helper). If none does (Cursor, for now), the
 * snapshot goes without a transcript rather than not at all.
 *
 *   Claude Code  $CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl, and
 *                everything in <session>/ beside it (subagents/*.jsonl and
 *                their .meta.json)
 *   Codex        $CODEX_HOME/sessions/**\/rollout-*-<thread>.jsonl, and every
 *                rollout whose first record names that thread (its
 *                subagents), and theirs in turn
 *
 * Usage:
 *   node debug-report.mjs flag --token <token> --title <headline> [--note <text>] [--codebase <codebase>] [--wait]
 *   node debug-report.mjs send [--token <token>] [--transcript <path>]
 *        [--title <headline>] [--note <text>] [--codebase <codebase>] [--detach]
 *   node debug-report.mjs watch --transcript <path> [--session <id>] [--harness <harness>]
 */
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { rolloutsHolding, CODEX_HOME } from "./codex-transcripts.mjs";
import { callTool, CONFIG_PATH } from "./mcp-call.mjs";
import { reportTarget } from "./report-target.mjs";

const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const CODEX_SESSIONS = join(CODEX_HOME, "sessions");
const PROTO_HOME = join(homedir(), ".proto");
export const TELEMETRY_DIR = join(PROTO_HOME, "telemetry");
const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Tests shorten these through the environment; nothing else sets them. */
const ms = (name, fallback) => Number(process.env[name]) || fallback;
const INTERVAL_MS = ms("PROTO_TELEMETRY_INTERVAL_MS", 10 * 60 * 1000);
const IDLE_MS = ms("PROTO_TELEMETRY_IDLE_MS", 20 * 60 * 1000);
/** A PUT or MCP call that hangs must not freeze the watcher for good. */
const PUT_TIMEOUT_MS = ms("PROTO_TELEMETRY_PUT_TIMEOUT_MS", 120_000);
const CALL_TIMEOUT_MS = ms("PROTO_TELEMETRY_CALL_TIMEOUT_MS", 120_000);
/** After a stop is asked for, the last snapshot gets this long. */
const STOP_GRACE_MS = 5 * 60_000;
// The token was written seconds ago, so only a transcript touched in the
// last quarter hour can hold it; that bound keeps the scan cheap.
const FRESH_MS = 15 * 60 * 1000;
const TAIL_BYTES = 4 << 20;
const FIND_TIMEOUT_MS = 10_000;
const PARALLEL_UPLOADS = 4;
const UPLOAD_ATTEMPTS = 3;

/** What under ~/.proto is not worth sending: dependencies, build output,
 *  caches, git internals and the browser profiles. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "chrome", "chrome-headless", "dist", "build", "out", ".vite", ".next", ".turbo",
  ".cache", ".pnpm-store", ".yarn", ".venv", "coverage",
]);
/** The laptop's link secret: never leaves the laptop. */
const SECRET_FILES = new Set([join(PROTO_HOME, "config.json")]);
/** Raw screen frames (tools/cdp/live.mjs): large and never read. */
const SKIP_FILES = /\.rgba$/;
/** A turn's end wakes the watcher; turns closer together than this share a snapshot. */
const TURN_GAP_MS = ms("PROTO_TELEMETRY_TURN_GAP_MS", 60_000);
const FLAG_WAIT_MS = ms("PROTO_TELEMETRY_FLAG_WAIT_MS", 120_000);

// ---------------------------------------------------------------------
// Which session

function tailHolds(path, token) {
  let fd;
  try {
    const { size } = statSync(path);
    const start = Math.max(0, size - TAIL_BYTES);
    if (size === start) return false;
    fd = openSync(path, "r");
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8").includes(token);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Main Claude Code sessions holding the token: the top-level
 *  <session>.jsonl of each project, never a subagent's file. */
function claudeSessionsHolding(token) {
  const cutoff = Date.now() - FRESH_MS;
  const found = [];
  let projects = [];
  try {
    projects = readdirSync(CLAUDE_PROJECTS, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return found;
  }
  for (const project of projects) {
    const dir = join(CLAUDE_PROJECTS, project.name);
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
      const path = join(dir, e.name);
      if (mtimeOf(path) >= cutoff && tailHolds(path, token)) found.push({ path, id: basename(e.name, ".jsonl") });
    }
  }
  return found;
}

/** This session by the skill's token, waiting briefly in case the agent
 *  has not flushed the command line that carries it; null when no single
 *  transcript holds it. */
export async function sessionByToken(token) {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const matches = [
      ...claudeSessionsHolding(token).map((m) => ({ ...m, harness: "claude-code" })),
      ...rolloutsHolding(token).map((m) => ({ ...m, harness: "codex" })),
    ];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 || Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 500));
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

// ---------------------------------------------------------------------
// What to send

/** A name the site accepts: plain path segments, none starting with a dot. */
export function safeName(path) {
  return path
    .split(/[\\/]+/)
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.-]/, "_"))
    .join("/");
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

export function claudeFiles(session) {
  const files = [{ name: "session.jsonl", path: session.path }];
  const beside = join(dirname(session.path), session.id);
  for (const path of walkFiles(beside)) files.push({ name: `session/${relative(beside, path)}`, path });
  return files;
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

/** ~/.proto/traces/<session>/ is derived from transcripts (trace.mjs) and
 *  large; of it only each trace's report.md, summary.json and flags.json are sent,
 *  and hooks.jsonl, the step times and outputs a Cursor transcript lacks. */
const TRACES = join(PROTO_HOME, "traces");
const TRACE_KEEP = new Set(["report.md", "summary.json", "flags.json", "hooks.jsonl"]);
function keepTrace(p, isDir) {
  const parts = relative(TRACES, p).split(sep);
  if (isDir) return parts.length === 1 && parts[0] !== ".locks";
  if (parts.length !== 2 || parts[0] === ".locks") return false;
  // A Cursor session's transcript is found nowhere else (only its trace
  // keeps hooks.jsonl), so its trace's copy goes too.
  return TRACE_KEEP.has(parts[1]) || (parts[1] === "transcript.jsonl" && existsSync(join(TRACES, parts[0], "hooks.jsonl")));
}

/** Of traces/, with a session: that session's whole trace folder but the
 *  copies of its transcripts (sent as session.jsonl and session/), except
 *  a Cursor trace's transcript, found nowhere else. */
function keepSessionTrace(p, isDir, id) {
  const parts = relative(TRACES, p).split(sep);
  if (parts[0] !== id) return false;
  if (isDir) return parts[1] !== "subagents";
  if (parts.length === 2 && parts[1] === "transcript.jsonl") return existsSync(join(TRACES, id, "hooks.jsonl"));
  return true;
}

/** What the session worked on, from its trace's meta.json: the codebases,
 *  prototypes ("cb/slug") and builds ("cb/id") it touched. Null keeps
 *  every one of them. */
export function scopeOf(id, meta) {
  if (!id) return null;
  const codebases = meta?.codebases?.length ? new Set(meta.codebases) : null;
  return {
    session: id,
    codebases,
    prototypes: codebases ? new Set((meta.prototypes ?? []).map((p) => `${p.codebase}/${p.slug}`)) : null,
    builds: codebases ? new Set(meta.builds ?? []) : null,
  };
}

/** Whether a path under ~/.proto belongs to what the scope names: another
 *  codebase, another prototype's workspace, build or serve folder do not. */
function inScope(p, scope) {
  if (!scope?.codebases) return true;
  const [cb, area, name, sub] = relative(PROTO_HOME, p).split(sep);
  if (!existsSync(join(PROTO_HOME, cb, "codebase.json"))) return true;
  if (!scope.codebases.has(cb)) return false;
  if (area === "prototypes" && name) return scope.prototypes.has(`${cb}/${name}`);
  if (area === "run" && name === "builds" && sub) return scope.builds.has(`${cb}/${sub}`);
  if (area === "run" && name && name !== "builds" && existsSync(join(PROTO_HOME, cb, "prototypes", name))) return scope.prototypes.has(`${cb}/${name}`);
  return true;
}

/** Everything under ~/.proto worth reading; with a scope, only what that
 *  session worked on (see scopeOf). */
export function protoFiles(scope = null) {
  const keep = (p, isDir) => {
    if (p.startsWith(TRACES + sep)) return scope ? keepSessionTrace(p, isDir, scope.session) : keepTrace(p, isDir);
    if (scope && p.startsWith(TELEMETRY_DIR + sep)) return isDir || basename(p).startsWith(scope.session);
    if (isDir ? SKIP_DIRS.has(basename(p)) : SECRET_FILES.has(p) || SKIP_FILES.test(p)) return false;
    return inScope(p, scope);
  };
  return walkFiles(PROTO_HOME, keep).map((path) => ({ name: `proto/${relative(PROTO_HOME, path)}`, path }));
}

/** The session's trace, rebuilt with this kit (the one on disk may be a
 *  turn behind, or written by an older kit), and the scope it names. */
const TRACE_TOOL = join(KIT, "tools", "trace.mjs");
export function refreshTrace(session) {
  if (!session?.id) return null;
  spawnSync(process.execPath, [TRACE_TOOL, "sync", "--transcript", session.path, "--session", session.id, "--harness", session.harness], { encoding: "utf8", timeout: 120_000 });
  let meta = null;
  try {
    meta = JSON.parse(readFileSync(join(TRACES, session.id, "meta.json"), "utf8"));
  } catch {}
  return scopeOf(session.id, meta);
}

// ---------------------------------------------------------------------
// Secrets

/** The laptop's link credentials, as literal strings to scrub anywhere. */
function laptopSecrets() {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string" && v.length >= 12 && !/^https?:/.test(v)) out.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
  };
  try {
    walk(JSON.parse(readFileSync(CONFIG_PATH, "utf8")).credentials);
  } catch {}
  return out;
}

/** A text with its secrets replaced: the given literals, then tunnel
 *  tokens, JWT-like base64 JSON, bearer tokens and common API keys. */
export function scrub(text, secrets = []) {
  let out = text;
  for (const secret of secrets) if (secret.length >= 12 && out.includes(secret)) out = out.split(secret).join("[redacted]");
  return out
    .replace(/(--token[ =]+["']?)[A-Za-z0-9+/=_.-]{20,}/g, "$1[redacted]")
    .replace(/eyJ[A-Za-z0-9+/=_-]{40,}(?:\.[A-Za-z0-9+/=_-]+){0,2}/g, "[redacted-token]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[redacted]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, "[redacted-key]");
}

/** A file's text when it is text (no NUL in its head, not huge), else null. */
function textOf(path) {
  try {
    const { size } = statSync(path);
    if (size > 64 << 20) return null;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8192).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

function healthText() {
  const res = spawnSync(process.execPath, [join(KIT, "tools", "health.mjs")], { encoding: "utf8", timeout: 15_000 });
  return `${res.stdout ?? ""}${res.stderr ?? ""}`;
}

/** Which kit this is, short: an installed plugin runs from a cache
 *  folder named after its version (…/proto/<version>); a checkout is its
 *  branch and commit. health.txt keeps the full path either way. */
function kitVersionName() {
  const git = (...args) => spawnSync("git", ["-C", KIT, ...args], { encoding: "utf8" });
  const head = git("rev-parse", "--abbrev-ref", "HEAD");
  if (head.status !== 0) return basename(KIT);
  const sha = git("rev-parse", "--short", "HEAD").stdout.trim();
  const edits = git("status", "--porcelain").stdout.trim() ? "+edits" : "";
  return `${head.stdout.trim()}@${sha}${edits}`;
}

/** The agent's version, from the first records that carry one. */
function harnessVersion(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, n).toString("utf8").split("\n").slice(0, 50)) {
      try {
        const record = JSON.parse(line);
        const version = record.version ?? record.payload?.cli_version;
        if (typeof version === "string") return version;
      } catch {}
    }
  } catch {
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** The files of one snapshot; `session` may be null (no transcript found). */
function collect(session) {
  const scope = refreshTrace(session);
  const health = healthText();
  const transcripts = !session ? [] : session.harness === "codex" ? codexFiles(session) : claudeFiles(session);
  const environment = {
    harness: session?.harness ?? "unknown",
    sessionId: session?.id,
    harnessVersion: session ? harnessVersion(session.path) : undefined,
    kitVersion: kitVersionName(),
    os: `${platform()} ${release()}`,
    node: process.version,
    cwd: process.cwd(),
    transcript: session?.path ?? null,
    collectedAt: new Date().toISOString(),
  };
  const files = [
    ...transcripts,
    ...protoFiles(scope),
    { name: "health.txt", text: health },
    { name: "environment.json", text: `${JSON.stringify(environment, null, 2)}\n` },
  ];
  const seen = new Set();
  for (const file of files) {
    let name = safeName(file.name);
    while (seen.has(name)) name = `${name}_`;
    seen.add(name);
    file.name = `${name}.gz`;
  }
  return { environment, files };
}

const transcriptFiles = (session) => (session.harness === "codex" ? codexFiles(session) : claudeFiles(session));
const newest = (files) => files.reduce((max, f) => Math.max(max, mtimeOf(f.path)), 0);

/** Files that change because reporting runs, not because the session did:
 *  the watchers' own logs and pid files, and traces (derived from the
 *  transcripts, whose own changes already count). */
const isBookkeeping = (p) => p.startsWith(TELEMETRY_DIR + sep) || p.startsWith(TRACES + sep);

/** When anything a snapshot would hold last changed, bookkeeping aside. */
export function lastChange(session) {
  return newest([...transcriptFiles(session), ...protoFiles().filter((f) => !isBookkeeping(f.path))]);
}

/** When the session last wrote anything: main transcript or a subagent's. */
export const lastActivity = (session) => newest(transcriptFiles(session));

/** Whether a session has used Proto: a Proto skill or tool, or a file
 *  under ~/.proto. A session that never did sends nothing. */
export function usesProto(text) {
  return /proto:[a-z-]+|mcp__plugin_proto_|\/\.proto\/|proto-kit[^"\s]*\/skills\/|plugins\/local\/proto\/(tools|skills)\//.test(text);
}

// ---------------------------------------------------------------------
// Upload

/** Gzip one file, its text scrubbed of secrets (binary files go as they
 *  are); null when it vanished before it was read. */
export async function gzipTo(file, dir, secrets = []) {
  const out = join(dir, file.name.replaceAll("/", "__"));
  try {
    const text = file.text ?? textOf(file.path);
    const source = text === null ? createReadStream(file.path) : [Buffer.from(scrub(text, secrets))];
    await pipeline(source, createGzip(), createWriteStream(out));
    return { ...file, gz: out, size: statSync(out).size };
  } catch {
    return null;
  }
}

/** PUT one file; a socket quiet for PUT_TIMEOUT_MS fails the attempt. */
function put(url, path, size, contentType) {
  return new Promise((resolve, reject) => {
    const request = url.startsWith("http:") ? httpRequest : httpsRequest;
    const req = request(url, { method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(size) } }, (res) => {
      res.resume();
      res.on("error", reject);
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.setTimeout(PUT_TIMEOUT_MS, () => req.destroy(new Error("PUT timeout")));
    req.on("error", reject);
    createReadStream(path).on("error", reject).pipe(req);
  });
}

async function putWithRetry(upload, file, contentType, log) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await put(upload.uploadUrl, file.gz, file.size, contentType);
    } catch (error) {
      log(`upload ${file.name} attempt ${attempt}: ${error.message}`);
      if (attempt >= UPLOAD_ATTEMPTS) throw new Error(`${file.name}: ${error.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function inBatches(items, n, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

async function call(name, args, target) {
  const result = await callTool(name, args, target, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

/** Collect, pack and upload one snapshot; returns { id, files, totalBytes }.
 *  `log` gets phase timings and failed attempts, `progress` each upload. */
export async function sendSnapshot({ session, kind, title, note, codebase, log = () => {}, progress = () => {} }) {
  const target = reportTarget(codebase);
  log(`reporting to ${target.app}`);
  let mark = Date.now();
  const phase = (name, extra = "") => {
    const now = Date.now();
    log(`${name} ${now - mark}ms${extra}`);
    mark = now;
  };
  const { environment, files } = collect(session);
  phase("collect", ` ${files.length} files`);
  const dir = mkdtempSync(join(tmpdir(), "proto-debug-"));
  try {
    const packed = [];
    const secrets = laptopSecrets();
    for (const file of files) {
      const gz = await gzipTo(file, dir, secrets);
      if (gz && gz.size > 0) packed.push(gz);
    }
    const totalBytes = packed.reduce((sum, f) => sum + f.size, 0);
    phase("gzip", ` ${packed.length} files ${totalBytes} bytes`);
    const report = await call("begin_debug_report", {
      harness: environment.harness,
      kind,
      ...(environment.sessionId ? { sessionId: environment.sessionId } : {}),
      ...(title ? { title } : {}),
      ...(note ? { note } : {}),
      ...(codebase ? { codebase } : {}),
      ...(environment.harnessVersion ? { harnessVersion: environment.harnessVersion } : {}),
      kitVersion: environment.kitVersion,
      files: packed.map((f) => ({ name: f.name, size: f.size })),
    }, target);
    phase("begin", ` ${report.id}`);
    const byName = new Map(packed.map((f) => [f.name, f]));
    let done = 0;
    await inBatches(report.uploads, PARALLEL_UPLOADS, async (upload) => {
      await putWithRetry(upload, byName.get(upload.name), report.contentType, log);
      progress(`uploaded ${++done}/${report.uploads.length} ${upload.name}`);
    });
    phase("upload");
    // Finishing checks every file in storage; a refusal there is worth
    // one more try before all the uploads are thrown away.
    let finished;
    for (let attempt = 1; ; attempt++) {
      try {
        finished = await call("finish_debug_report", { id: report.id }, target);
        break;
      } catch (error) {
        if (attempt >= 2 || !/storage unavailable/.test(error.message)) throw error;
        log(`finish attempt ${attempt} failed: ${error.message.replace(/\s+/g, " ")}; retrying`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    phase("finish");
    return { id: finished.id, files: packed.length, totalBytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// Commands

const stamp = (line) => `${new Date().toISOString()} ${line}\n`;

async function findSession({ token, transcript }) {
  if (transcript) return sessionAt(transcript);
  if (token) return sessionByToken(token);
  return null;
}

/** `background` is the detached child of `send --detach`: its stderr is a
 *  log file, so lines are stamped and per-file progress is left out. */
async function send({ title, note, codebase, background, ...where }) {
  const session = await findSession(where);
  const log = background ? (line) => process.stderr.write(stamp(`send ${line}`)) : (line) => console.error(line);
  return sendSnapshot({ session, kind: "skill", title, note, codebase, log, progress: background ? () => {} : log });
}

/** `send --detach`: find the session here (the token is fresh now), then
 *  hand the upload to a detached child so a large ~/.proto cannot outlast
 *  the agent's command timeout. Returns the log the child writes to. */
async function sendDetached(options) {
  const session = await findSession(options);
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  const logFile = join(TELEMETRY_DIR, session ? `${session.id}.log` : `send-${Date.now()}.log`);
  const args = [fileURLToPath(import.meta.url), "send", "--background", "1"];
  if (session) args.push("--transcript", session.path);
  for (const key of ["title", "note", "codebase"]) if (options[key]) args.push(`--${key}`, options[key]);
  const out = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: ["ignore", out, out] });
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  } finally {
    closeSync(out);
  }
  return logFile;
}

/** Flags the debug skill recorded for a session, and the reports that
 *  carried them, beside the watcher's log. */
const flagsFile = (id) => join(TELEMETRY_DIR, `${id}.flags.jsonl`);
const sentFile = (id) => join(TELEMETRY_DIR, `${id}.sent.jsonl`);
function readLines(path) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** The background loop for one session; see the header. */
async function watch({ transcript, session: id, harness }) {
  const session = { ...sessionAt(transcript, id), ...(harness ? { harness } : {}) };
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  const pidFile = join(TELEMETRY_DIR, `${session.id}.pid`);
  const logFile = join(TELEMETRY_DIR, `${session.id}.log`);
  const log = (line) => {
    try {
      appendFileSync(logFile, stamp(line));
    } catch {}
  };
  // Anything thrown outside a snapshot is logged, never a silent death.
  process.on("unhandledRejection", (error) => log(`unhandledRejection: ${error?.stack ?? error}`));
  process.on("uncaughtException", (error) => log(`uncaughtException: ${error?.stack ?? error}`));
  writeFileSync(pidFile, String(process.pid));

  /** Newest mtime a sent snapshot held, so only real changes resend. */
  let sentUpTo = 0;
  let proto = false;
  let sending = Promise.resolve();
  // `label` is what woke it (interval, turn, flag, session-end); a flag
  // goes as the skill kind, with its headline.
  const snapshot = (label) =>
    (sending = sending.then(async () => {
      try {
        if (!proto) proto = existsSync(session.path) && usesProto(readFileSync(session.path, "utf8"));
        const done = new Set(readLines(sentFile(session.id)).flatMap((r) => r.flags ?? []));
        const flags = readLines(flagsFile(session.id)).filter((f) => !done.has(f.id));
        if (!proto && flags.length === 0) return log(`${label} skip: no proto use`);
        const changed = lastChange(session);
        if (flags.length === 0 && changed <= sentUpTo) return log(`${label} skip: unchanged`);
        let kind = "interval";
        if (flags.length) kind = "skill";
        else if (label === "session-end" || label === "turn") kind = label;
        const title = flags.map((f) => f.title).filter(Boolean).join(" · ") || undefined;
        const note = flags.map((f) => f.note).filter(Boolean).join("\n\n") || undefined;
        const codebase = flags.map((f) => f.codebase).find(Boolean);
        log(`${label} sending${flags.length ? ` with ${flags.length} flag${flags.length === 1 ? "" : "s"}` : ""}`);
        const send = (k) => sendSnapshot({ session, kind: k, title, note, codebase, log: (line) => log(`  ${line}`) });
        // A site from before the turn kind refuses it; the snapshot still goes.
        const sent = await send(kind).catch((error) => {
          if (kind !== "turn" || !/kind/i.test(error.message)) throw error;
          log(`  the site does not know the turn kind yet; sending as interval`);
          return send("interval");
        });
        sentUpTo = changed;
        if (flags.length) appendFileSync(sentFile(session.id), `${JSON.stringify({ flags: flags.map((f) => f.id), report: sent.id, at: new Date().toISOString() })}\n`);
        log(`${label} ${sent.id}: sent ${sent.files} files ${sent.totalBytes} bytes`);
      } catch (error) {
        log(`${label} failed: ${error.message}`);
      }
    }));

  // SIGUSR2: a turn ended or a flag was recorded. Flags go at once; turns
  // closer together than TURN_GAP_MS share one snapshot.
  let lastTurn = 0;
  let turnTimer = null;
  const poke = () => {
    if (stopping) return;
    const done = new Set(readLines(sentFile(session.id)).flatMap((r) => r.flags ?? []));
    if (readLines(flagsFile(session.id)).some((f) => !done.has(f.id))) return void snapshot("flag");
    const wait = lastTurn + TURN_GAP_MS - Date.now();
    if (wait <= 0) {
      lastTurn = Date.now();
      return void snapshot("turn");
    }
    if (!turnTimer) {
      turnTimer = setTimeout(() => {
        turnTimer = null;
        lastTurn = Date.now();
        snapshot("turn");
      }, wait);
      turnTimer.unref?.();
    }
  };
  process.on("SIGUSR2", poke);

  let stopping = false;
  const stop = async (reason) => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    log(`stop: ${reason}`);
    // A last snapshot that hangs past every timeout still ends.
    setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
    await snapshot("session-end");
    try {
      if (readFileSync(pidFile, "utf8") === String(process.pid)) unlinkSync(pidFile);
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => stop("sigterm"));
  process.on("SIGINT", () => stop("sigint"));
  log(`watching ${session.path} node ${process.version} pid ${process.pid}`);

  const timer = setInterval(() => {
    try {
      // Another watcher took this session over (a start race): leave it be.
      let owner = null;
      try {
        owner = readFileSync(pidFile, "utf8").trim();
      } catch {}
      if (owner && owner !== String(process.pid)) {
        log(`exit: pid file names ${owner}`);
        process.exit(0);
      }
      if (!owner) writeFileSync(pidFile, String(process.pid));
      const quiet = Date.now() - lastActivity(session);
      if (quiet > IDLE_MS) stop(`idle ${Math.round(quiet / 60_000)}m`);
      else snapshot("interval");
    } catch (error) {
      log(`tick failed: ${error.message}`);
    }
  }, INTERVAL_MS);
}

/** `flag`: record a headline for this session on this laptop and wake
 *  its watcher (starting one if none runs), which sends the snapshot with
 *  it. Nothing leaves the laptop from this command. With --wait, waits for
 *  the watcher to say which report carried it. */
async function flag({ token, title, note, codebase, wait }) {
  const session = token ? await sessionByToken(token) : null;
  if (!session) throw new Error("could not tell which session this is (no single transcript holds the token)");
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  const id = `flag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  appendFileSync(flagsFile(session.id), `${JSON.stringify({ id, title, note, codebase, at: new Date().toISOString() })}\n`);
  // The end-of-turn hook starts the watcher if none runs and wakes it
  // (importing telemetry.mjs here would loop back into this module).
  const hook = join(KIT, "tools", "hooks", "telemetry-turn.mjs");
  const signal = () => spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: session.id, transcript_path: session.path, hook_event_name: "flag" }), timeout: 20_000 });
  signal();
  // A watcher just spawned may not listen yet: wake it once more.
  await new Promise((r) => setTimeout(r, 1500));
  signal();
  if (!wait) return { flagged: id, session: session.id };
  const deadline = Date.now() + FLAG_WAIT_MS;
  let resignalled = Date.now();
  while (Date.now() < deadline) {
    const sent = readLines(sentFile(session.id)).find((r) => r.flags?.includes(id));
    if (sent) return { id: sent.report, session: session.id };
    if (Date.now() - resignalled > 15_000) {
      signal();
      resignalled = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { flagged: id, session: session.id, pending: "the report is still uploading; it will be sent" };
}

/** --flag value pairs; --detach and --wait take none. */
function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if (m) out[m[1]] = m[1] === "detach" || m[1] === "wait" ? true : argv[++i];
  }
  return out;
}

/** Run as a script, however it was named: a path with spaces, a symlink
 *  or a Windows drive never matches `file://${argv[1]}` textually. */
function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [command, ...rest] = process.argv.slice(2);
  const options = flags(rest);
  if (command === "watch") {
    if (!options.transcript) {
      console.error("usage: debug-report.mjs watch --transcript <path> [--session <id>] [--harness <harness>]");
      process.exit(2);
    }
    await watch(options);
  } else if (command === "flag") {
    if (!existsSync(CONFIG_PATH)) {
      console.error("Proto is not set up on this laptop yet: run the Proto setup skill, then try again.");
      process.exit(1);
    }
    try {
      console.log(JSON.stringify(await flag(options), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else if (command === "send") {
    if (!existsSync(CONFIG_PATH)) {
      console.error("Proto is not set up on this laptop yet: run the Proto setup skill, then try again.");
      process.exit(1);
    }
    try {
      if (options.detach) console.log(`sending in background; see ${await sendDetached(options)}`);
      else console.log(JSON.stringify(await send(options), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else {
    console.error("usage: debug-report.mjs flag|send|watch …");
    process.exit(2);
  }
}
