import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { gzipTo, safeName, sessionAt, usesProto } from "./debug-report.mjs";

test("file names become plain path segments the site accepts", () => {
  assert.equal(safeName("session/subagents/agent-a1.jsonl"), "session/subagents/agent-a1.jsonl");
  assert.equal(safeName("proto/my codebase/.run/daemon.log"), "proto/my_codebase/_run/daemon.log");
  assert.equal(safeName("/abs//path\\x.log"), "abs/path/x.log");
});

test("a packed file is exactly the original, gzipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  // 65535 ASCII bytes, so the 3-byte "—" straddles a 64 KiB read, and a
  // secret-looking string that must arrive untouched.
  const body = `${"a".repeat(65_535)}— and 🙂 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA ${"b".repeat(70_000)}\n`;
  writeFileSync(join(dir, "in.jsonl"), body);
  const packed = await gzipTo({ name: "in.jsonl.gz", path: join(dir, "in.jsonl") }, dir);
  assert.equal(gunzipSync(readFileSync(packed.gz)).toString(), body);
});

test("binary files survive packing byte for byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3]);
  writeFileSync(join(dir, "in.png"), bytes);
  const packed = await gzipTo({ name: "proto/in.png.gz", path: join(dir, "in.png") }, dir);
  assert.deepEqual(gunzipSync(readFileSync(packed.gz)), bytes);
});

test("a file that vanished before packing is skipped, not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  assert.equal(await gzipTo({ name: "gone.log.gz", path: join(dir, "gone.log") }, dir), null);
});

test("a session that touched Proto is recognised; one that did not is not", () => {
  assert.equal(usesProto('{"skill":"proto:create-prototype"}'), true);
  assert.equal(usesProto('{"name":"mcp__plugin_proto_proto__whoami"}'), true);
  assert.equal(usesProto('"file_path":"/Users/a/.proto/acme/library/x.tsx"'), true);
  assert.equal(usesProto('"command":"node /Users/a/.cursor/plugins/local/proto/tools/serve.mjs"'), true);
  assert.equal(usesProto('{"text":"refactor the billing page"}'), false);
});

test("a transcript path says which agent and session it is", () => {
  const claude = sessionAt("/Users/a/.claude/projects/-x/fc6eead5-4396-4450-925e-022cd814d1af.jsonl");
  assert.equal(claude.harness, "claude-code");
  assert.equal(claude.id, "fc6eead5-4396-4450-925e-022cd814d1af");
});

// ---------------------------------------------------------------------
// End to end against a local fake Proto site and storage; never the real one.

const tool = fileURLToPath(new URL("./debug-report.mjs", import.meta.url));
const sid = "33333333-3333-4333-8333-333333333333";

async function fakeSite(t, { hang = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "debug-report-e2e-"));
  const transcript = join(home, ".claude", "projects", "p", `${sid}.jsonl`);
  const proto = join(home, ".proto");
  const begins = [];
  const puts = [];
  const finishes = [];
  const server = createServer(async (req, res) => {
    if (req.method === "PUT") {
      puts.push(req.url);
      if (hang) return; // never answers
      req.resume();
      req.on("end", () => res.end());
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const { name, arguments: args } = body.params ?? {};
    let result = {};
    const base = `http://127.0.0.1:${server.address().port}`;
    if (name === "begin_debug_report") {
      begins.push(args);
      const id = `r${begins.length}`;
      result = { id, contentType: "application/gzip", uploads: args.files.map((f) => ({ name: f.name, uploadUrl: `${base}/put/${id}/${f.name}` })) };
    }
    if (name === "finish_debug_report") {
      finishes.push(args.id);
      result = { id: args.id };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const app = `http://127.0.0.1:${server.address().port}`;
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, `${JSON.stringify({ skill: "proto:create-prototype" })}\n`);
  mkdirSync(join(proto, "acme", "node_modules"), { recursive: true });
  mkdirSync(join(proto, "acme", "coverage"), { recursive: true });
  writeFileSync(join(proto, "config.json"), JSON.stringify({ app, credentials: [{ secret: "laptop-secret" }] }));
  writeFileSync(join(proto, "acme", "notes.md"), "notes\n");
  writeFileSync(join(proto, "acme", "node_modules", "dep.js"), "x\n");
  writeFileSync(join(proto, "acme", "coverage", "c.json"), "{}\n");
  const trace = join(proto, "traces", "older-session");
  mkdirSync(join(trace, "subagents"), { recursive: true });
  mkdirSync(join(proto, "traces", ".locks"), { recursive: true });
  for (const name of ["report.md", "summary.json", "steps.jsonl", "trace.html", "chat.md", "transcript.jsonl", "subagents/a.jsonl"]) writeFileSync(join(trace, name), "x\n");
  writeFileSync(join(proto, "traces", "sync.log"), "x\n");
  writeFileSync(join(proto, "traces", ".locks", "l"), "x\n");
  const children = [];
  t.after(async () => {
    for (const c of children) try { c.kill("SIGKILL"); } catch {}
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const env = (extra = {}) => ({ ...process.env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), CODEX_HOME: join(home, ".codex"), PROTO_APP: app, ...extra });
  const run = (args, extra) => {
    const child = spawn(process.execPath, [tool, ...args], { env: env(extra), stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.done = new Promise((resolve) => child.once("close", (status) => resolve({ status, stdout, stderr })));
    return child;
  };
  const logFile = join(proto, "telemetry", `${sid}.log`);
  const log = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
  return { home, transcript, begins, puts, finishes, run, log, pidFile: join(proto, "telemetry", `${sid}.pid`) };
}

async function until(check, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("send uploads ~/.proto without the laptop secret or skipped folders", async (t) => {
  const f = await fakeSite(t);
  const { status, stderr } = await f.run(["send", "--transcript", f.transcript, "--title", "t"]).done;
  assert.equal(status, 0, stderr);
  const names = f.begins[0].files.map((x) => x.name);
  assert.ok(names.includes("session.jsonl.gz"));
  assert.ok(names.includes("proto/acme/notes.md.gz"));
  assert.ok(!names.some((n) => /config\.json|node_modules|coverage/.test(n)), names.join(" "));
  // Of traces/, only each trace's report and summary.
  assert.deepEqual(names.filter((n) => n.startsWith("proto/traces/")).sort(), [
    "proto/traces/older-session/report.md.gz",
    "proto/traces/older-session/summary.json.gz",
  ]);
  assert.equal(f.puts.length, names.length);
  assert.deepEqual(f.finishes, ["r1"]);
});

test("send gives up on storage that never answers, in bounded time", async (t) => {
  const f = await fakeSite(t, { hang: true });
  const started = Date.now();
  const { status, stderr } = await f.run(["send", "--transcript", f.transcript], { PROTO_TELEMETRY_PUT_TIMEOUT_MS: "200" }).done;
  assert.equal(status, 1);
  assert.match(stderr, /PUT timeout/);
  assert.ok(Date.now() - started < 30_000);
  assert.deepEqual(f.finishes, []);
});

test("send --detach returns at once and uploads in the background", async (t) => {
  const f = await fakeSite(t);
  const { status, stdout, stderr } = await f.run(["send", "--transcript", f.transcript, "--detach"]).done;
  assert.equal(status, 0, stderr);
  assert.match(stdout, /sending in background; see .*\.log/);
  await until(() => f.finishes.length === 1);
  await until(() => /send finish/.test(f.log()));
});

test("the watcher resends only when the session changed, not its own log", async (t) => {
  const f = await fakeSite(t);
  const w = f.run(["watch", "--transcript", f.transcript], { PROTO_TELEMETRY_INTERVAL_MS: "300" });
  await until(() => f.finishes.length === 1);
  await until(() => (f.log().match(/skip: unchanged/g) ?? []).length >= 3);
  assert.equal(f.begins.length, 1);
  // A trace sync rewriting derived files is not a change of its own.
  writeFileSync(join(f.home, ".proto", "traces", "older-session", "steps.jsonl"), "y\n");
  writeFileSync(join(f.home, ".proto", "traces", "sync.log"), "y\n");
  const skips = (f.log().match(/skip: unchanged/g) ?? []).length;
  await until(() => (f.log().match(/skip: unchanged/g) ?? []).length >= skips + 2);
  assert.equal(f.begins.length, 1);
  writeFileSync(f.transcript, `${JSON.stringify({ skill: "proto:create-prototype" })}\n{"more":1}\n`);
  await until(() => f.finishes.length === 2);
  w.kill("SIGTERM");
  const { status } = await w.done;
  assert.equal(status, 0);
  assert.equal(f.begins.length, 2, "session-end with nothing new sends nothing");
  assert.match(f.log(), /stop: sigterm/);
  assert.equal(existsSync(f.pidFile), false);
});

test("a watcher stuck on storage still exits on SIGTERM", async (t) => {
  const f = await fakeSite(t, { hang: true });
  const w = f.run(["watch", "--transcript", f.transcript], { PROTO_TELEMETRY_INTERVAL_MS: "300", PROTO_TELEMETRY_PUT_TIMEOUT_MS: "300" });
  await until(() => f.puts.length > 0);
  const started = Date.now();
  w.kill("SIGTERM");
  const { status } = await w.done;
  assert.equal(status, 0);
  assert.ok(Date.now() - started < 60_000);
  assert.match(f.log(), /attempt 1: PUT timeout/);
  assert.match(f.log(), /stop: sigterm/);
});

test("run through a symlink in a folder with a space, it still runs as a script", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "debug-report-main-")), "a b");
  mkdirSync(dir);
  symlinkSync(tool, join(dir, "debug-report.mjs"));
  const res = spawnSync(process.execPath, [join(dir, "debug-report.mjs")], { encoding: "utf8" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /usage: debug-report\.mjs send\|watch/);
});
