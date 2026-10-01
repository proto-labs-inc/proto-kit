#!/usr/bin/env node
/**
 * Send Proto a debug report: this agent session's whole transcript, its
 * subagents' transcripts and the laptop's Proto logs, so the team can see
 * exactly what happened. Only ever run by the debug skill, and `send`
 * only after the user has said yes.
 *
 * Which session is this? The read-only transcript helper finds the token the skill
 * puts a token it made up on the command line, that command lands in
 * this session's transcript on disk, and exactly one transcript holds
 * it. Zero matches or two are an error, never a guess. Claude Code and
 * Codex are searched together, so the match also says which agent this
 * is. Cursor is not supported yet.
 *
 *   Claude Code  $CLAUDE_CONFIG_DIR/projects/<project>/<session>.jsonl, and
 *                everything in <session>/ beside it (subagents/*.jsonl and
 *                their .meta.json)
 *   Codex        $CODEX_HOME/sessions/**\/rollout-*-<thread>.jsonl, and every
 *                rollout whose first record names that thread (its
 *                subagents), and theirs in turn
 *
 * Nothing is trimmed and there is no size limit. The one change to any
 * file: credentials are replaced with [redacted:<kind>] markers (this
 * laptop's Proto secrets, and strings shaped like API keys and tokens).
 * Each file is gzipped to a temporary folder, then PUT to the signed URL
 * begin_debug_report returns, streamed with its exact Content-Length
 * (a chunked body would fail the signature).
 *
 * Usage:
 *   node debug-report.mjs plan --token <token>
 *       Print { harness, files: [{ name, bytes }], totalBytes } for the
 *       confirmation question. Sends nothing.
 *   node debug-report.mjs send --token <token> [--note <text>] [--codebase <codebase>]
 *       Collect again (the session has grown since plan), upload, confirm
 *       with finish_debug_report, and print { id, files, totalBytes }.
 */
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, mkdtempSync, openSync, readFileSync, readSync, closeSync, readdirSync, rmSync, statSync } from "node:fs";
import { request } from "node:https";
import { homedir, platform, release, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { rolloutsHolding, CODEX_HOME } from "./codex-transcripts.mjs";
import { callTool, CONFIG_PATH } from "./mcp-call.mjs";

const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const CODEX_SESSIONS = join(CODEX_HOME, "sessions");
const PROTO_HOME = join(homedir(), ".proto");
const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

// The token was written seconds ago, so only a transcript touched in the
// last quarter hour can hold it; that bound keeps the scan cheap.
const FRESH_MS = 15 * 60 * 1000;
const TAIL_BYTES = 4 << 20;
const FIND_TIMEOUT_MS = 10_000;
const PARALLEL_UPLOADS = 4;
const UPLOAD_ATTEMPTS = 3;

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

function freshFile(path, cutoff) {
  try {
    return statSync(path).mtimeMs >= cutoff;
  } catch {
    return false;
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
      if (freshFile(path, cutoff) && tailHolds(path, token)) found.push({ path, id: basename(e.name, ".jsonl") });
    }
  }
  return found;
}

/** This session, waiting briefly in case the agent has not flushed the
 *  command line that carries the token yet. */
async function findSession(token) {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  for (;;) {
    const matches = [
      ...claudeSessionsHolding(token).map((m) => ({ ...m, harness: "claude-code" })),
      ...rolloutsHolding(token).map((m) => ({ ...m, harness: "codex" })),
    ];
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`the token ${token} is in ${matches.length} transcripts (${matches.map((m) => m.path).join(", ")}); run the skill again with a new token`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `no Claude Code or Codex transcript holds the token ${token}. This agent may be Cursor, which the debug report does not support yet.`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
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

function claudeFiles(session) {
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
function codexFiles(session) {
  const started = statSync(session.path).birthtimeMs || 0;
  const rollouts = walkFiles(CODEX_SESSIONS, (p, isDir) => isDir || (/rollout-.*\.jsonl$/.test(p) && freshFile(p, started)))
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

/** Every log the kit wrote under ~/.proto, but not the browser profile. */
function protoLogs() {
  return walkFiles(PROTO_HOME, (p, isDir) => (isDir ? !/\/(chrome|node_modules)$/.test(p) : p.endsWith(".log"))).map(
    (path) => ({ name: `proto/${relative(PROTO_HOME, path)}`, path }),
  );
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

function collect(session) {
  const health = healthText();
  const kitVersion = kitVersionName();
  const transcripts = session.harness === "claude-code" ? claudeFiles(session) : codexFiles(session);
  const environment = {
    harness: session.harness,
    harnessVersion: harnessVersion(session.path),
    kitVersion,
    os: `${platform()} ${release()}`,
    node: process.version,
    cwd: process.cwd(),
    transcript: session.path,
    collectedAt: new Date().toISOString(),
  };
  const files = [
    ...transcripts,
    ...protoLogs(),
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

// ---------------------------------------------------------------------
// Redaction

/** This laptop's own Proto secrets: every credential in config.json and
 *  any secret or token a run dir keeps. */
function knownSecrets() {
  const secrets = new Set();
  const take = (value) => {
    if (typeof value === "string" && value.length >= 12) secrets.add(value);
  };
  const grab = (node) => {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (/^(secret|token|relayToken|password)$/i.test(key)) take(value);
      if (typeof value === "object") grab(value);
    }
  };
  for (const path of [CONFIG_PATH, ...walkFiles(PROTO_HOME, (p, isDir) => (isDir ? !/\/(chrome|node_modules)$/.test(p) : p.endsWith("courier.json")))]) {
    try {
      grab(JSON.parse(readFileSync(path, "utf8")));
    } catch {}
  }
  return [...secrets].sort((a, b) => b.length - a.length);
}

const SECRET_SHAPES = [
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ["aws-key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
  ["bearer", /(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g],
];

export function redact(text, secrets) {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted:proto-secret]");
  for (const [kind, shape] of SECRET_SHAPES) {
    out = out.replace(shape, (match, prefix) => (kind === "bearer" ? `${prefix}[redacted:${kind}]` : `[redacted:${kind}]`));
  }
  return out;
}

/** Redact line by line, so a secret is never split across two chunks. */
function redactor(secrets) {
  // One decoder across chunks, so a character split between two reads is
  // joined rather than replaced.
  const decoder = new StringDecoder("utf8");
  let carry = "";
  return new Transform({
    transform(chunk, _encoding, done) {
      const text = carry + decoder.write(chunk);
      const end = text.lastIndexOf("\n");
      if (end === -1) {
        carry = text;
        return done();
      }
      carry = text.slice(end + 1);
      done(null, redact(text.slice(0, end + 1), secrets));
    },
    flush(done) {
      const rest = carry + decoder.end();
      done(null, rest ? redact(rest, secrets) : undefined);
    },
  });
}

export async function gzipTo(file, dir, secrets) {
  const out = join(dir, file.name.replaceAll("/", "__"));
  const source = file.text === undefined ? createReadStream(file.path) : [Buffer.from(file.text)];
  await pipeline(source, redactor(secrets), createGzip(), createWriteStream(out));
  return { ...file, gz: out, size: statSync(out).size };
}

// ---------------------------------------------------------------------
// Upload

function put(url, path, size, contentType) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(size) } }, (res) => {
      res.resume();
      res.on("end", () => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on("error", reject);
    createReadStream(path).on("error", reject).pipe(req);
  });
}

async function putWithRetry(upload, file, contentType) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await put(upload.uploadUrl, file.gz, file.size, contentType);
    } catch (error) {
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

async function call(name, args) {
  const result = await callTool(name, args);
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
}

function sizeOf(file) {
  return file.text === undefined ? statSync(file.path).size : Buffer.byteLength(file.text);
}

// ---------------------------------------------------------------------
// Commands

async function plan({ token }) {
  const session = await findSession(token);
  const { environment, files } = collect(session);
  const listed = files.map((f) => ({ name: f.name.replace(/\.gz$/, ""), bytes: sizeOf(f) }));
  const subagents = files.filter((f) => /^(session\/subagents|subagents)\/.*\.jsonl\.gz$/.test(f.name)).length;
  return {
    harness: environment.harness,
    transcript: session.path,
    subagents,
    logs: files.filter((f) => f.name.startsWith("proto/")).length,
    files: listed,
    totalBytes: listed.reduce((sum, f) => sum + f.bytes, 0),
  };
}

async function send({ token, note, codebase }) {
  const session = await findSession(token);
  const { environment, files } = collect(session);
  const secrets = knownSecrets();
  const dir = mkdtempSync(join(tmpdir(), "proto-debug-"));
  try {
    console.error(`packing ${files.length} files…`);
    const packed = [];
    for (const file of files) packed.push(await gzipTo(file, dir, secrets));
    const totalBytes = packed.reduce((sum, f) => sum + f.size, 0);

    const report = await call("begin_debug_report", {
      harness: environment.harness,
      harnessVersion: environment.harnessVersion,
      kitVersion: environment.kitVersion,
      ...(codebase ? { codebase } : {}),
      ...(note ? { note } : {}),
      files: packed.map((f) => ({ name: f.name, size: f.size })),
    });
    const byName = new Map(packed.map((f) => [f.name, f]));
    let done = 0;
    await inBatches(report.uploads, PARALLEL_UPLOADS, async (upload) => {
      await putWithRetry(upload, byName.get(upload.name), report.contentType);
      console.error(`uploaded ${++done}/${report.uploads.length} ${upload.name}`);
    });
    const finished = await call("finish_debug_report", { id: report.id });
    return { id: finished.id, files: packed.length, totalBytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function flags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(\w+)$/.exec(argv[i]);
    if (m) out[m[1]] = argv[++i];
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const options = flags(rest);
  const run = { plan, send }[command];
  if (!run || !options.token) {
    console.error("usage: debug-report.mjs plan|send --token <token> [--note <text>] [--codebase <codebase>]");
    process.exit(2);
  }
  if (!existsSync(CONFIG_PATH) && command === "send") {
    console.error("Proto is not set up on this laptop yet: run the Proto setup skill, then try again.");
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await run(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
