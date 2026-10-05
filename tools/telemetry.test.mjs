import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const kit = fileURLToPath(new URL("../", import.meta.url));
const id = "11111111-1111-4111-8111-111111111111";

async function fixture(t, harness, { refused = false, ambiguous = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), "proto-first-session-"));
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const transcript = harness === "codex"
    ? join(codex, "sessions", `rollout-test-${id}.jsonl`)
    : join(claude, "projects", "test", `${id}.jsonl`);
  const code = "unique-setup-link-code";
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, JSON.stringify({ text: `node tools/link-laptop.mjs ${code}` }) + "\n");
  if (ambiguous) writeFileSync(join(dirname(transcript), "22222222-2222-4222-8222-222222222222.jsonl"), code);
  const pidFile = join(home, ".proto", "telemetry", `${id}.pid`);
  const requests = [];
  const identity = { user: { id: "member", email: "test@example.com" }, team: { id: "team", name: "Test" }, laptop: { id: "laptop" } };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const name = body.params?.name;
    requests.push(name ?? body.method);
    let result = {};
    if (name === "link_laptop") result = { content: [{ type: "text", text: JSON.stringify(refused ? { error: "expired" } : { ...identity, token: "fixture-token" }) }] };
    if (name === "whoami") result = { content: [{ type: "text", text: JSON.stringify({ ...identity, mode: "laptop-token" }) }] };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const logFile = join(home, ".proto", "telemetry", `${id}.log`);
  t.after(async () => {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch {}
    }
    const log = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
    for (const [, pid] of log.matchAll(/spawned pid (\d+)/g)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch {}
    }
    await new Promise((resolve) => server.close(resolve));
    rmSync(home, { recursive: true, force: true });
  });
  const app = `http://127.0.0.1:${server.address().port}`;
  // PROTO_APP keeps any watcher these tests start off the real site.
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PROTO_APP: app };
  async function run(tool, args = [], input = "") {
    const child = spawn(process.execPath, [join(kit, "tools", tool), ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(input);
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    return { status, stdout, stderr };
  }
  return {
    home, pidFile, requests, logFile, app,
    hook: () => run("hooks/telemetry-start.mjs", [], JSON.stringify({ session_id: id, transcript_path: transcript })),
    link: () => run("link-laptop.mjs", [`http://127.0.0.1:${server.address().port}`, code, "member"]),
  };
}

for (const harness of ["claude-code", "codex"]) {
  test(`${harness}: first-session linking starts reporting; retries and hooks reuse it`, async (t) => {
    const f = await fixture(t, harness);
    assert.equal((await f.hook()).status, 0);
    assert.equal(existsSync(f.pidFile), false, "unlinked session must not start reporting");
    const linked = await f.link();
    assert.equal(linked.status, 0, linked.stderr);
    assert.equal(linked.stderr, "");
    assert.equal(JSON.parse(linked.stdout).linkedAs.user.id, "member");
    const pid = Number(readFileSync(f.pidFile, "utf8"));
    process.kill(pid, 0);
    assert.equal((await f.hook()).status, 0);
    assert.equal((await f.link()).status, 0);
    assert.equal(Number(readFileSync(f.pidFile, "utf8")), pid);
    assert.equal(f.requests.filter((name) => name === "link_laptop").length, 1);
    assert.ok(f.requests.includes("whoami"));
  });
}

test("a rejected link does not start reporting or save configuration", async (t) => {
  const f = await fixture(t, "claude-code", { refused: true });
  assert.equal((await f.link()).status, 1);
  assert.equal(existsSync(f.pidFile), false);
  assert.equal(existsSync(join(f.home, ".proto", "config.json")), false);
});

test("ambiguous chats leave linking successful without guessing a transcript", async (t) => {
  const f = await fixture(t, "claude-code", { ambiguous: true });
  const linked = await f.link();
  assert.equal(linked.status, 0);
  assert.match(linked.stderr, /chat could not be identified/);
  assert.equal(existsSync(f.pidFile), false);
  assert.ok(existsSync(join(f.home, ".proto", "config.json")));
});

test("hooks racing at once start exactly one watcher", async (t) => {
  const f = await fixture(t, "claude-code");
  mkdirSync(join(f.home, ".proto"), { recursive: true });
  writeFileSync(join(f.home, ".proto", "config.json"), JSON.stringify({ app: f.app, credentials: [{ secret: "fixture-token" }] }));
  const results = await Promise.all(Array.from({ length: 8 }, () => f.hook()));
  assert.ok(results.every((r) => r.status === 0 && r.stdout === ""));
  const log = readFileSync(f.logFile, "utf8");
  const spawned = [...log.matchAll(/spawned pid (\d+)/g)].map((m) => Number(m[1]));
  assert.equal(spawned.length, 1, log);
  assert.equal(Number(readFileSync(f.pidFile, "utf8")), spawned[0]);
  assert.equal((log.match(/alive pid/g) ?? []).length, 7);
  assert.match(log, /start hook claude-code keys session_id,transcript_path alive pid/);
});

test("a stale pid file is replaced by a new watcher", async (t) => {
  const f = await fixture(t, "claude-code");
  mkdirSync(join(f.home, ".proto"), { recursive: true });
  writeFileSync(join(f.home, ".proto", "config.json"), JSON.stringify({ app: f.app, credentials: [{ secret: "fixture-token" }] }));
  mkdirSync(dirname(f.pidFile), { recursive: true });
  writeFileSync(f.pidFile, "999999");
  assert.equal((await f.hook()).status, 0);
  const pid = Number(readFileSync(f.pidFile, "utf8"));
  assert.notEqual(pid, 999999);
  process.kill(pid, 0);
});
