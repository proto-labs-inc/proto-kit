#!/usr/bin/env node
/**
 * Debug traces: each agent session that uses Proto, kept on this laptop
 * in ~/.proto/traces/<session>/ with what it took to read it.
 *
 * Every harness already writes the whole conversation to disk, every
 * message and every tool call with its input, output and time (the same
 * files debug reports send). `sync` copies the session's files into its
 * trace folder and works them up, so a trace survives the harness
 * pruning old sessions and sits beside the prototypes it built:
 *
 *   ~/.proto/traces/<session>/
 *     transcript.jsonl   the session as the harness wrote it
 *     subagents/         each subagent's own transcript (and .meta.json)
 *     meta.json          harness, source path, codebases and prototypes
 *     transcript.html    the page to read: where the time went, the flags, then
 *                        the conversation turn by turn, each step one line
 *     transcript/        each step's full input and output, a page apiece
 *     transcript.md      the same transcript for an agent to read, nothing cut
 *     report.md          the numbers and the rule-found signals, short
 *     summary.json       the same numbers, for tools
 *     flags.json         flags on steps and messages, by an agent or a person
 *
 * Every step has an id (s12, the twelfth tool call, counted by time across
 * subagents) and every message one (m3). `flag` marks either with a kind
 * and a note; the page shows flags inline and in a list at the top, and
 * they survive every regeneration. That is how an agent reading a trace
 * reports back: it flags, the person reads the flags.
 *
 * The end-of-turn hook (hooks/trace-sync.mjs) runs `sync` in the
 * background after every turn, so the folder is never more than a turn
 * behind. Sessions that never touch Proto are left alone. Past the
 * newest fifty traces, those not synced for a month are removed.
 *
 * Usage:
 *   node trace.mjs sync --transcript <path> [--session <id>] [--harness claude-code|codex|cursor]
 *   node trace.mjs import <transcript path | session id>   sync a past session by hand
 *   node trace.mjs import <folder>                         a debug report downloaded from
 *                                                          /staff/debug-reports (session.jsonl[.gz],
 *                                                          session/subagents/…, environment.json)
 *   node trace.mjs list [--codebase <cb>] [--slug <slug>]
 *   node trace.mjs report [<session> | latest] [--json]    work it up again and print it
 *   node trace.mjs show <session | latest> <step> [<step>…] [--full]   e.g. 12 or s12 or 10-14
 *   node trace.mjs grep <session | latest> <regex>
 *   node trace.mjs view [<session> | latest] [--open]      refresh and print transcript.html's path
 *   node trace.mjs flag <session | latest> <s12 | m3 | session> --kind error|slow|improve|note|good --note <text> [--by <who>]
 *   node trace.mjs flags <session | latest> [--json]
 *   node trace.mjs unflag <session | latest> <flag id | all>
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { claudeFiles, codexFiles, codexRollout, sessionAt, usesProto } from "./debug-report.mjs";
import { analyze, duration, readTrace, reportMarkdown } from "./trace-read.mjs";
import { FLAG_KINDS, transcriptHtml, transcriptMarkdown } from "./trace-transcript.mjs";

const PROTO_HOME = join(homedir(), ".proto");
export const TRACES_DIR = join(PROTO_HOME, "traces");
const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
const KIT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------
// Sync

/** The files to copy, named as the trace folder lays them out. Large
 *  tool outputs the harness keeps beside the transcript (screenshots)
 *  stay where they are. */
function sourceFiles(session) {
  const sub = /[\\/]subagents[\\/]agent-[^\\/]+\.jsonl$/.test(session.path);
  if (sub && session.harness === "claude-code") return [{ name: "transcript.jsonl", path: session.path }, ...descendants(session.path)];
  if (session.harness === "codex") return codexFiles(session).map((f) => ({ ...f, name: f.name === "session.jsonl" ? "transcript.jsonl" : f.name }));
  if (session.harness === "cursor") return [{ name: "transcript.jsonl", path: session.path }];
  return claudeFiles(session)
    .map((f) => ({ ...f, name: f.name === "session.jsonl" ? "transcript.jsonl" : f.name.replace(/^session\//, "") }))
    .filter((f) => f.name === "transcript.jsonl" || /^subagents\/[^/]+\.(jsonl|meta\.json)$/.test(f.name));
}

/** A Claude Code subagent traced on its own takes the subagents it
 *  launched along (they sit beside it, each .meta.json naming the tool
 *  call that started it), and theirs in turn. */
function descendants(path) {
  const dir = dirname(path);
  const metas = readdirSync(dir)
    .filter((f) => f.endsWith(".meta.json"))
    .map((f) => {
      try {
        return { file: f.replace(/\.meta\.json$/, ".jsonl"), meta: f, toolUseId: JSON.parse(readFileSync(join(dir, f), "utf8")).toolUseId };
      } catch {
        return null;
      }
    })
    .filter((m) => m?.toolUseId);
  const out = [];
  const queue = [path];
  const seen = new Set([basename(path)]);
  while (queue.length) {
    const text = readFileSync(queue.shift(), "utf8");
    for (const m of metas) {
      if (seen.has(m.file) || !text.includes(m.toolUseId)) continue;
      seen.add(m.file);
      queue.push(join(dir, m.file));
      out.push({ name: `subagents/${m.file}`, path: join(dir, m.file) }, { name: `subagents/${m.meta}`, path: join(dir, m.meta) });
    }
  }
  return out;
}

const PROTOTYPE_PATH = /\.proto\/([A-Za-z0-9._-]+)\/prototypes\/([A-Za-z0-9._-]+)/g;
const BUILD_PATH = /\.proto\/([A-Za-z0-9._-]+)\/run\/builds\/([A-Za-z0-9._-]+)/g;

/** Which codebases, prototypes and builds the session touched, from the
 *  paths and flags in it. */
function touched(text) {
  const prototypes = new Map();
  for (const m of text.matchAll(PROTOTYPE_PATH)) {
    if (m[2].endsWith(".json")) continue;
    prototypes.set(`${m[1]}/${m[2]}`, { codebase: m[1], slug: m[2] });
  }
  for (const m of text.matchAll(/--codebase[ =\\"]+([A-Za-z0-9._-]+)[^\n"]{0,200}?--slug[ =]\\?["']?([a-z][a-z0-9-]*)/g)) prototypes.set(`${m[1]}/${m[2]}`, { codebase: m[1], slug: m[2] });
  const builds = new Set();
  for (const m of text.matchAll(BUILD_PATH)) builds.add(`${m[1]}/${m[2]}`);
  const codebases = new Set([...prototypes.values()].map((p) => p.codebase));
  for (const m of text.matchAll(/--codebase[ =\\"]+([A-Za-z0-9._-]+)/g)) codebases.add(m[1]);
  for (const c of ["traces", "telemetry", "chrome", "chrome-headless", "config.json"]) codebases.delete(c);
  return { codebases: [...codebases], prototypes: [...prototypes.values()].filter((p) => codebases.has(p.codebase)), builds: [...builds] };
}

function copyIfChanged(from, to) {
  try {
    const a = statSync(from);
    if (existsSync(to)) {
      const b = statSync(to);
      if (a.size === b.size && a.mtimeMs <= b.mtimeMs) return false;
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to + ".tmp");
    renameSync(to + ".tmp", to);
    return true;
  } catch {
    return false;
  }
}

function writeAtomic(path, text) {
  writeFileSync(path + ".tmp", text);
  renameSync(path + ".tmp", path);
}

/** Copy one session into its trace folder and work it up. Returns the
 *  folder, or null when the session has nothing to do with Proto. */
export function sync(session, { force = false } = {}) {
  if (!session?.path || !existsSync(session.path)) return null;
  const dir = join(TRACES_DIR, session.id);
  const metaPath = join(dir, "meta.json");
  const text = readFileSync(session.path, "utf8");
  // A Cursor install runs the kit from plugins/local/proto, which the
  // debug reporter's test does not know; the hook's log is proof too.
  const proto = usesProto(text) || /plugins\/local\/proto\/(tools|skills)\//.test(text) || existsSync(join(dir, "hooks.jsonl"));
  if (!existsSync(metaPath) && !force && !proto) return null;
  mkdirSync(dir, { recursive: true });
  for (const f of sourceFiles(session)) copyIfChanged(f.path, join(dir, f.name));
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {}
  writeAtomic(metaPath, JSON.stringify({ ...meta, sessionId: session.id, harness: session.harness, source: session.path, kit: KIT, ...touched(text), syncedAt: new Date().toISOString() }, null, 2) + "\n");
  workUp(dir);
  return dir;
}

/** The written-up forms of one trace folder. */
export function workUp(dir) {
  const trace = readTrace(dir);
  const summary = analyze(trace);
  const flags = readFlags(dir);
  writeAtomic(join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeAtomic(join(dir, "report.md"), reportMarkdown(trace, summary, flags));
  const transcript = transcriptHtml(dir, { trace, summary, flags });
  rmSync(join(dir, "transcript"), { recursive: true, force: true });
  mkdirSync(join(dir, "transcript"), { recursive: true });
  for (const [name, page] of transcript.pages) writeFileSync(join(dir, "transcript", name), page);
  writeAtomic(join(dir, "transcript.html"), transcript.html);
  writeAtomic(join(dir, "transcript.md"), transcriptMarkdown(dir, { trace, flags }));
  // Files earlier versions wrote, now folded into the transcript.
  for (const old of ["trace.html", "chat.md", "steps.jsonl"]) rmSync(join(dir, old), { force: true });
  return { trace, summary };
}

// ---------------------------------------------------------------------
// Flags

function readFlags(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "flags.json"), "utf8"));
  } catch {
    return [];
  }
}

function flag(dir, args) {
  const target = args.find((a) => /^(s\d+|m\d+|session)$/.test(a)) ?? fail("flag needs a step (s12), a message (m3) or session");
  const kind = arg(args, "--kind") ?? "note";
  if (!FLAG_KINDS.includes(kind)) fail(`--kind is one of ${FLAG_KINDS.join(", ")}`);
  const note = arg(args, "--note") ?? fail("flag needs --note <text>");
  const flags = readFlags(dir);
  const id = `f${flags.reduce((n, f) => Math.max(n, Number(f.id.slice(1)) || 0), 0) + 1}`;
  flags.push({ id, target, kind, note, by: arg(args, "--by") ?? process.env.USER ?? "", at: new Date().toISOString() });
  writeAtomic(join(dir, "flags.json"), JSON.stringify(flags, null, 2) + "\n");
  return id;
}

/** The hook's sync: one at a time per session. A turn that ends while
 *  a sync is running leaves a mark, and the running one goes again, so
 *  the last turn is always covered without syncs piling up. */
function syncInBackground(session) {
  const locks = join(TRACES_DIR, ".locks");
  mkdirSync(locks, { recursive: true });
  const lock = join(locks, `${session.id}.pid`);
  const again = join(locks, `${session.id}.again`);
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" });
  } catch {
    let alive = false;
    try {
      process.kill(Number(readFileSync(lock, "utf8")), 0);
      alive = true;
    } catch {}
    if (alive) return writeFileSync(again, "");
    writeFileSync(lock, String(process.pid));
  }
  try {
    for (let round = 0; round < 5; round++) {
      rmSync(again, { force: true });
      sync(session);
      if (!existsSync(again)) break;
    }
  } catch (error) {
    console.error(`${new Date().toISOString()} ${session.id} sync failed: ${error.stack ?? error.message}`);
  } finally {
    rmSync(lock, { force: true });
  }
  prune();
}

const KEEP_TRACES = 50;
const KEEP_DAYS = 30;

/** Old traces go, so the folder stays a few hundred MB at most: past
 *  the newest fifty, anything not synced for a month. */
function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const dir of traceDirs().slice(KEEP_TRACES)) {
    try {
      if (statSync(join(dir, "meta.json")).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** A debug report someone downloaded, laid out as a trace. Its files
 *  keep the names the reporter gave them (session.jsonl, session/…,
 *  proto/…), gzipped or not, nested or flattened with "__". */
function importReport(folder) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(folder);
  const named = (p) => relative(folder, p).replaceAll("__", "/").replace(/\.gz$/, "");
  const read = (p) => (p.endsWith(".gz") ? gunzipSync(readFileSync(p)) : readFileSync(p));
  let env = {};
  const envFile = files.find((p) => named(p).endsWith("environment.json"));
  if (envFile) env = JSON.parse(read(envFile).toString("utf8"));
  const id = env.sessionId ?? `report-${basename(folder)}`;
  // The session's own trace files, when the laptop had a trace of it:
  // its flags, and for Cursor its transcript and the hook's step log.
  const own = (name) => files.find((p) => named(p).endsWith(`traces/${id}/${name}`));
  const main = files.find((p) => /(^|\/)session\.jsonl$/.test(named(p))) ?? own("transcript.jsonl") ?? fail(`No session.jsonl in ${folder}.`);
  const dir = join(TRACES_DIR, id);
  mkdirSync(join(dir, "subagents"), { recursive: true });
  writeFileSync(join(dir, "transcript.jsonl"), read(main));
  for (const p of files) {
    const n = named(p);
    const m = /(?:^|\/)(?:session\/)?subagents\/([^/]+\.(?:jsonl|meta\.json))$/.exec(n);
    if (m) writeFileSync(join(dir, "subagents", m[1]), read(p));
  }
  for (const name of ["flags.json", "hooks.jsonl"]) if (own(name)) writeFileSync(join(dir, name), read(own(name)));
  const text = readFileSync(join(dir, "transcript.jsonl"), "utf8");
  writeAtomic(join(dir, "meta.json"), JSON.stringify({ sessionId: id, harness: env.harness === "unknown" && own("hooks.jsonl") ? "cursor" : env.harness ?? "claude-code", source: null, report: folder, environment: env, ...touched(text), syncedAt: new Date().toISOString() }, null, 2) + "\n");
  workUp(dir);
  return dir;
}

// ---------------------------------------------------------------------
// Finding a trace

function traceDirs() {
  if (!existsSync(TRACES_DIR)) return [];
  return readdirSync(TRACES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(TRACES_DIR, e.name, "meta.json")))
    .map((e) => join(TRACES_DIR, e.name))
    .sort((a, b) => statSync(join(b, "meta.json")).mtimeMs - statSync(join(a, "meta.json")).mtimeMs);
}

/** A trace by session id (or its first characters), or the latest. */
function traceDir(ref) {
  const dirs = traceDirs();
  if (!ref || ref === "latest") return dirs[0] ?? fail("No traces yet in ~/.proto/traces.");
  if (existsSync(join(ref, "meta.json"))) return ref;
  const hits = dirs.filter((d) => basename(d).startsWith(ref));
  if (hits.length === 1) return hits[0];
  fail(hits.length ? `"${ref}" matches ${hits.length} traces; give more of the id.` : `No trace "${ref}" in ~/.proto/traces (try: trace.mjs import ${ref}).`);
}

/** A past session by transcript path or session id, from any harness. */
function findSession(ref) {
  if (existsSync(ref)) {
    const s = sessionAt(ref);
    return ref.includes(`${join(".cursor", "")}`) ? { ...s, harness: "cursor" } : s;
  }
  if (existsSync(CLAUDE_PROJECTS)) {
    for (const p of readdirSync(CLAUDE_PROJECTS)) {
      const path = join(CLAUDE_PROJECTS, p, `${ref}.jsonl`);
      if (existsSync(path)) return sessionAt(path, ref);
      const prefix = readdirSync(join(CLAUDE_PROJECTS, p)).find((f) => f.startsWith(ref) && f.endsWith(".jsonl"));
      if (prefix) return sessionAt(join(CLAUDE_PROJECTS, p, prefix));
    }
  }
  const rollout = codexRollout(ref);
  if (rollout) return sessionAt(rollout, ref);
  fail(`No transcript found for "${ref}".`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------------
// Commands

function arg(args, name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function list(args) {
  const codebase = arg(args, "--codebase");
  const slug = arg(args, "--slug");
  const rows = [];
  for (const dir of traceDirs()) {
    let meta = {};
    let s = {};
    try {
      meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
      s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
    } catch {}
    if (codebase && !(meta.codebases ?? []).includes(codebase)) continue;
    if (slug && !(meta.prototypes ?? []).some((p) => p.slug === slug)) continue;
    const high = (s.struggles ?? []).filter((x) => x.severity === "high").length;
    rows.push(`${basename(dir)}  ${String(s.session?.firstAt ?? "").slice(0, 16).replace("T", " ")}  ${(meta.harness ?? "").padEnd(11)}  ${duration(s.activeMs).padStart(7)} working  ${String(s.counts?.toolCalls ?? "?").padStart(4)} steps  ${String(s.counts?.errors ?? "?").padStart(3)} failed  ${high} high  ${(meta.prototypes ?? []).map((p) => `${p.codebase}/${p.slug}`).join(" ") || (meta.codebases ?? []).join(" ")}`);
  }
  console.log(rows.length ? rows.join("\n") : "No traces yet in ~/.proto/traces.");
}

/** Steps in full: what went in, what came out, and what the model said
 *  just before (from the transcript, not cut). */
function show(dir, which, full) {
  const wanted = new Set(
    which.replace(/s/g, "").split(",").flatMap((w) => {
      const [a, b] = w.split("-").map(Number);
      return b ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : [a];
    }),
  );
  const trace = readTrace(dir);
  for (const t of trace.tools.filter((x) => wanted.has(x.n))) {
    const req = trace.requests.find((r) => r.id === t.request);
    console.log(`── s${t.n} · ${t.agent === "main" ? "main" : `subagent ${t.agent}`} · ${t.name} · ${new Date(t.at).toISOString().slice(11, 19)} · ${duration(t.ms)}${t.error ? " · FAILED" : ""}${t.unfinished ? " · never returned" : ""}`);
    if (req?.text) console.log(`model said: ${req.text.trim().slice(0, full ? Infinity : 600)}`);
    console.log(`input: ${JSON.stringify(t.input, null, 2).slice(0, full ? Infinity : 3000)}`);
    console.log(`output (${t.outputBytes} chars): ${full ? t.output : t.output.slice(0, 2500)}`);
    console.log("");
  }
}

function grep(dir, pattern) {
  const re = new RegExp(pattern, "i");
  for (const t of readTrace(dir).tools) {
    const hay = `${t.label}\n${JSON.stringify(t.input)}\n${t.output}`;
    if (re.test(hay)) {
      const line = hay.split("\n").find((l) => re.test(l)) ?? "";
      console.log(`s${t.n} ${t.error ? "FAILED " : ""}${t.group}: ${line.trim().slice(0, 200)}`);
    }
  }
}

/** A trace worked up again, from a fresh copy when its session is still
 *  on disk, so it covers what happened since the last turn ended. */
function refresh(dir) {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {}
  if (meta.source && existsSync(meta.source)) sync({ id: meta.sessionId, path: meta.source, harness: meta.harness }, { force: true });
  else workUp(dir);
  return dir;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "sync") {
    const path = arg(args, "--transcript");
    const id = arg(args, "--session");
    const harness = arg(args, "--harness");
    const session = path ? { ...sessionAt(path, id), ...(harness ? { harness } : {}) } : id ? findSession(id) : fail("sync needs --transcript or --session");
    if (args.includes("--background")) return syncInBackground(session);
    const dir = sync(session);
    if (dir && args.includes("--print")) console.log(dir);
    return;
  }
  if (cmd === "import" && args[0] && existsSync(args[0]) && statSync(args[0]).isDirectory()) {
    const dir = importReport(args[0]);
    console.log(readFileSync(join(dir, "report.md"), "utf8"));
    console.log(`Trace: ${dir}`);
    return;
  }
  if (cmd === "import") {
    const dir = sync(findSession(args[0] ?? fail("import needs a transcript path or session id")), { force: true });
    console.log(readFileSync(join(dir, "report.md"), "utf8"));
    console.log(`Trace: ${dir}`);
    return;
  }
  if (cmd === "list") return list(args);
  if (cmd === "report") {
    const dir = refresh(traceDir(args.find((a) => !a.startsWith("--"))));
    console.log(args.includes("--json") ? readFileSync(join(dir, "summary.json"), "utf8") : readFileSync(join(dir, "report.md"), "utf8"));
    console.log(`Trace: ${dir}`);
    return;
  }
  if (cmd === "show") {
    const which = args.slice(1).filter((a) => !a.startsWith("--")).join(",");
    return show(traceDir(args[0]), which || fail("show needs step numbers, e.g. 12 or 10-14"), args.includes("--full"));
  }
  if (cmd === "grep") return grep(traceDir(args[0]), args[1] ?? fail("grep needs a pattern"));
  if (cmd === "view" || cmd === "transcript") {
    const dir = refresh(traceDir(args.find((a) => !a.startsWith("--"))));
    console.log(join(dir, "transcript.html"));
    if (args.includes("--open") && process.platform === "darwin") spawnSync("open", [join(dir, "transcript.html")]);
    return;
  }
  if (cmd === "flag") {
    const dir = traceDir(args[0]);
    const id = flag(dir, args.slice(1));
    workUp(dir);
    console.log(`${id} on ${args.slice(1).find((a) => /^(s\d+|m\d+|session)$/.test(a))}; ${join(dir, "transcript.html")}`);
    return;
  }
  if (cmd === "flags") {
    const flags = readFlags(traceDir(args[0]));
    if (args.includes("--json")) return console.log(JSON.stringify(flags, null, 2));
    console.log(flags.length ? flags.map((f) => `${f.id}  ${f.target.padEnd(7)} ${f.kind.padEnd(8)} ${f.note}${f.by ? `  (${f.by})` : ""}`).join("\n") : "No flags.");
    return;
  }
  if (cmd === "unflag") {
    const dir = traceDir(args[0]);
    const which = args[1] ?? fail("unflag needs a flag id (f3) or all");
    writeAtomic(join(dir, "flags.json"), JSON.stringify(which === "all" ? [] : readFlags(dir).filter((f) => f.id !== which), null, 2) + "\n");
    workUp(dir);
    return;
  }
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").match(/Usage:[\s\S]*?\*\//)[0].replace(/\n \*\/?/g, "\n"));
  process.exit(cmd ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
