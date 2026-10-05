import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { analyze, readTrace } from "./trace-read.mjs";

const kit = fileURLToPath(new URL("../", import.meta.url));
const id = "33333333-3333-4333-8333-333333333333";
const t = (s) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
const jsonl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

function home() {
  const h = mkdtempSync(join(tmpdir(), "proto-trace-"));
  return { h, env: { ...process.env, HOME: h, CLAUDE_CONFIG_DIR: join(h, ".claude"), CODEX_HOME: join(h, ".codex") } };
}

function run(env, ...args) {
  return spawnSync(process.execPath, [join(kit, "tools", "trace.mjs"), ...args], { env, encoding: "utf8" });
}

/** A Claude Code session that builds a prototype: a person's message,
 *  a skill, a Proto script that fails three times running, a subagent. */
function claudeSession() {
  const base = { sessionId: id, cwd: "/work", version: "2.1.0" };
  const use = (s, rid, tid, name, input) => ({ ...base, type: "assistant", timestamp: t(s), requestId: rid, message: { model: "claude-test", content: [{ type: "tool_use", id: tid, name, input }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 50 } } });
  const result = (s, tid, text, isError = false) => ({ ...base, type: "user", timestamp: t(s), message: { content: [{ type: "tool_result", tool_use_id: tid, content: text, is_error: isError }] } });
  const build = 'node ~/kit/tools/proto-build.mjs b1 --codebase calibre --slug book-detail';
  return jsonl([
    { ...base, type: "user", timestamp: t(0), message: { content: "Build the book detail prototype" } },
    use(5, "r1", "t1", "Skill", { skill: "proto:create-prototype" }),
    result(6, "t1", "Launching skill"),
    use(10, "r2", "t2", "Bash", { command: build }),
    result(12, "t2", "Error: page not found on port 9333", true),
    use(14, "r3", "t3", "Bash", { command: build }),
    result(16, "t3", "Error: page not found on port 9333", true),
    use(18, "r4", "t4", "Bash", { command: build }),
    result(20, "t4", "Error: page not found on port 9333", true),
    use(25, "r5", "t5", "Agent", { subagent_type: "proto:part-fixer", description: "Fix header" }),
    { ...result(26, "t5", "launched"), toolUseResult: { agentId: "sub1", status: "async_launched" } },
    use(30, "r6", "t6", "Bash", { command: "sleep 90; cat ~/.proto/calibre/prototypes/book-detail/src/App.tsx" }),
    result(120, "t6", "ok"),
    { ...base, type: "assistant", timestamp: t(130), requestId: "r7", message: { model: "claude-test", content: [{ type: "text", text: "The prototype is built." }], usage: { input_tokens: 5, output_tokens: 20 } } },
  ]);
}

function subagent() {
  const base = { sessionId: id, isSidechain: true, agentId: "sub1" };
  return jsonl([
    { ...base, type: "user", timestamp: t(26), message: { content: "Fix the header part" } },
    { ...base, type: "assistant", timestamp: t(30), requestId: "s1", message: { content: [{ type: "tool_use", id: "u1", name: "Edit", input: { file_path: "/x/Header.tsx", old_string: "a", new_string: "b" } }] } },
    { ...base, type: "user", timestamp: t(31), message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "ok" }] } },
    { ...base, type: "assistant", timestamp: t(40), requestId: "s2", message: { content: [{ type: "text", text: "Fixed." }] } },
  ]);
}

function claudeHome() {
  const { h, env } = home();
  const transcript = join(h, ".claude", "projects", "-work", `${id}.jsonl`);
  mkdirSync(join(dirname(transcript), id, "subagents"), { recursive: true });
  writeFileSync(transcript, claudeSession());
  writeFileSync(join(dirname(transcript), id, "subagents", "agent-sub1.jsonl"), subagent());
  writeFileSync(join(dirname(transcript), id, "subagents", "agent-sub1.meta.json"), JSON.stringify({ agentType: "proto:part-fixer", description: "Fix header" }));
  return { h, env, transcript };
}

test("import lays a Claude Code session out as a trace and flags the struggle", () => {
  const { h, env } = claudeHome();
  const res = run(env, "import", id);
  assert.equal(res.status, 0, res.stderr);
  const dir = join(h, ".proto", "traces", id);
  for (const f of ["transcript.jsonl", "subagents/agent-sub1.jsonl", "meta.json", "report.md", "summary.json", "transcript.html", "transcript.md", "transcript/s2.html"]) assert.ok(existsSync(join(dir, f)), f);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  assert.deepEqual(meta.prototypes, [{ codebase: "calibre", slug: "book-detail" }]);
  const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  assert.equal(s.counts.toolCalls, 7);
  assert.equal(s.counts.errors, 3);
  assert.equal(s.counts.subagents, 1);
  const kinds = s.struggles.map((x) => x.kind);
  for (const k of ["error-streak", "repeat", "errors", "slow"]) assert.ok(kinds.includes(k), `${k} in ${kinds}`);
  const streak = s.struggles.find((x) => x.kind === "error-streak");
  assert.deepEqual(streak.steps, [2, 3, 4]);
  assert.ok(s.groups.some((g) => g.group === "proto proto-build" && g.errors === 3));
  assert.ok(s.groups.some((g) => g.group === "Bash (sleep/poll)"));
  // Time is partitioned: the main session's buckets add up to its wall clock.
  const sum = Object.values(s.mainBuckets).reduce((n, v) => n + v, 0);
  assert.equal(sum, s.wallMs);
  assert.match(readFileSync(join(dir, "transcript.md"), "utf8"), /m1 · Person[\s\S]*Build the book detail prototype[\s\S]*s2 · Bash · [^\n]*FAILED/);
});

test("the transcript shows everything, with each subagent under the call that started it", () => {
  const { h, env } = claudeHome();
  const transcript = join(h, ".claude", "projects", "-work", `${id}.jsonl`);
  writeFileSync(transcript, readFileSync(transcript, "utf8") + jsonl([
    { sessionId: id, type: "attachment", timestamp: t(121), attachment: { type: "queued_command", prompt: "also check the cover", origin: { kind: "human" }, humanTurn: true } },
    { sessionId: id, type: "attachment", timestamp: t(122), attachment: { type: "queued_command", prompt: "<task-notification><task-id>sub1</task-id></task-notification>", origin: { kind: "task-notification" } } },
  ]));
  writeFileSync(join(dirname(transcript), id, "subagents", "agent-sub1.meta.json"), JSON.stringify({ agentType: "proto:part-fixer", description: "Fix header", toolUseId: "t5" }));
  assert.equal(run(env, "import", id).status, 0);
  const dir = join(h, ".proto", "traces", id);
  const html = readFileSync(join(dir, "transcript.html"), "utf8");
  const md = readFileSync(join(dir, "transcript.md"), "utf8");
  for (const text of ["Build the book detail prototype", "Error: page not found on port 9333", "The prototype is built.", "also check the cover"]) {
    assert.ok(html.includes(text), `html has ${text}`);
    assert.ok(md.includes(text), `md has ${text}`);
  }
  assert.match(html, /Person, while the agent worked/);
  assert.match(html, /subagent <b>proto:part-fixer<\/b>: Fix header[\s\S]*Fix the header part[\s\S]*Header\.tsx/);
  // Each step is one line linking to a page with its full input and output.
  const page = /<a href="(transcript\/s\d+\.html)">Edit<\/a>/.exec(html)?.[1];
  assert.ok(page, "step links to its own page");
  assert.match(readFileSync(join(dir, page), "utf8"), /old_string&quot;: &quot;a&quot;[\s\S]*ok/);
  assert.match(html, /<details class="turn" id="turn1"/);
  assert.match(html, /href="#s2">s2<\/a>/);
  assert.match(md, /# Subagent proto:part-fixer: Fix header[\s\S]*Fixed\./);
  const s = JSON.parse(readFileSync(join(dir, "summary.json"), "utf8"));
  assert.equal(s.counts.personMessages, 2);
});

test("flags mark steps and messages, show on the page and in transcript.md, and survive regeneration", () => {
  const { h, env } = claudeHome();
  run(env, "import", id);
  const dir = join(h, ".proto", "traces", id);
  assert.match(run(env, "flag", id.slice(0, 8), "s3", "--kind", "improve", "--note", "the build retried the same failing page", "--by", "claude").stdout, /^f1 on s3/);
  assert.match(run(env, "flag", "latest", "m1", "--kind", "note", "--note", "the ask").stdout, /^f2 on m1/);
  assert.equal(run(env, "flag", "latest", "s3", "--kind", "bogus", "--note", "x").status, 1);
  run(env, "import", id);
  const html = readFileSync(join(dir, "transcript.html"), "utf8");
  assert.match(html, /<div class="step flag improve" id="s3">[\s\S]*?<div class="note"><b>improve<\/b> the build retried the same failing page/);
  assert.match(html, /<a href="#s3">s3<\/a><\/td><td>the build retried/);
  assert.match(readFileSync(join(dir, "transcript.md"), "utf8"), /s3 · Bash[^\n]*\n> FLAG f1 improve: the build retried the same failing page \(claude\)/);
  assert.match(readFileSync(join(dir, "report.md"), "utf8"), /f1 \*\*improve\*\* on s3/);
  assert.match(run(env, "flags", "latest").stdout, /f1\s+s3\s+improve/);
  run(env, "unflag", "latest", "f1");
  assert.doesNotMatch(run(env, "flags", "latest").stdout, /f1/);
});

test("show and grep open steps; list finds the trace by prototype", () => {
  const { env } = claudeHome();
  run(env, "import", id);
  const shown = run(env, "show", id.slice(0, 8), "2-3");
  assert.match(shown.stdout, /s2 .*FAILED[\s\S]*proto-build[\s\S]*s3/);
  assert.match(run(env, "show", id.slice(0, 8), "s4").stdout, /s4 .*FAILED/);
  assert.match(run(env, "grep", "latest", "port 9333").stdout, /s2 FAILED/);
  assert.match(run(env, "list", "--slug", "book-detail").stdout, new RegExp(id));
  assert.match(run(env, "list", "--slug", "other").stdout, /No traces/);
});

test("the hook syncs a Proto session in the background and leaves others alone", async () => {
  const { h, env, transcript } = claudeHome();
  const other = join(h, ".claude", "projects", "-work", "44444444-4444-4444-8444-444444444444.jsonl");
  writeFileSync(other, jsonl([{ type: "user", timestamp: t(0), message: { content: "unrelated work" } }]));
  const hook = (input) => spawnSync(process.execPath, [join(kit, "tools", "hooks", "trace-hook.mjs")], { env, input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(hook({ session_id: id, transcript_path: transcript, hook_event_name: "Stop" }).status, 0);
  assert.equal(hook({ session_id: "44444444-4444-4444-8444-444444444444", transcript_path: other, hook_event_name: "Stop" }).status, 0);
  const report = join(h, ".proto", "traces", id, "report.md");
  for (let i = 0; i < 50 && !existsSync(report); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(existsSync(report), "Proto session traced");
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!existsSync(join(h, ".proto", "traces", "44444444-4444-4444-8444-444444444444")), "unrelated session not traced");
});

test("a Codex rollout reads into the same shape", () => {
  const { h, env } = home();
  const rollout = join(h, ".codex", "sessions", "2026", "10", "01", `rollout-2026-10-01T10-00-00-${id}.jsonl`);
  mkdirSync(dirname(rollout), { recursive: true });
  writeFileSync(rollout, jsonl([
    { timestamp: t(0), type: "session_meta", payload: { id, cwd: "/work", cli_version: "0.50.0" } },
    { timestamp: t(0), type: "turn_context", payload: { model: "gpt-test" } },
    { timestamp: t(1), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "$create-prototype for calibre" }] } },
    { timestamp: t(5), type: "response_item", payload: { type: "function_call", name: "shell", call_id: "c1", arguments: JSON.stringify({ command: ["bash", "-lc", "node ~/kit/tools/scaffold.mjs --codebase calibre"] }) } },
    { timestamp: t(9), type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: JSON.stringify({ output: "boom", metadata: { exit_code: 1 } }) } },
    { timestamp: t(9), type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 900, cached_input_tokens: 800, output_tokens: 40 } } } },
    { timestamp: t(12), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Scaffold failed." }] } },
  ]));
  assert.equal(run(env, "import", rollout).status, 0);
  const trace = readTrace(join(h, ".proto", "traces", id));
  assert.equal(trace.session.harness, "codex");
  assert.equal(trace.tools.length, 1);
  assert.equal(trace.tools[0].group, "proto scaffold");
  assert.equal(trace.tools[0].ms, 4000);
  assert.equal(trace.tools[0].error, true);
  assert.equal(trace.prompts[0].from, "person");
});

test("a Cursor transcript takes its times and output from the hook's log", () => {
  const { h, env } = home();
  const conv = "cursor-conv-1";
  const transcript = join(h, ".cursor", "projects", "work", "agent-transcripts", conv, `${conv}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, jsonl([
    { role: "user", message: { content: [{ type: "text", text: "<user_query>build a prototype with proto</user_query>" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Reading the skill." }, { type: "tool_use", name: "Shell", input: { command: "node ~/.cursor/plugins/local/proto/tools/proto-build.mjs b1" } }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
  ]));
  const hook = (input) => spawnSync(process.execPath, [join(kit, "tools", "hooks", "trace-hook.mjs")], { env, input: JSON.stringify(input), encoding: "utf8" });
  const post = hook({ conversation_id: conv, cursor_version: "2.0", hook_event_name: "postToolUse", tool_name: "Shell", tool_input: { command: "node ~/.cursor/plugins/local/proto/tools/proto-build.mjs b1" }, tool_output: "built", duration: 3000, transcript_path: transcript });
  assert.equal(post.stdout.trim(), "{}");
  assert.ok(existsSync(join(h, ".proto", "traces", conv, "hooks.jsonl")));
  assert.equal(run(env, "sync", "--transcript", transcript, "--session", conv, "--harness", "cursor").status, 0);
  const trace = readTrace(join(h, ".proto", "traces", conv));
  assert.equal(trace.tools.length, 1);
  assert.equal(trace.tools[0].ms, 3000);
  assert.equal(trace.tools[0].output, "built");
  assert.ok(!trace.session.untimed);
  assert.equal(analyze(trace).counts.personMessages, 1);
});

test("a downloaded debug report imports as a trace", () => {
  const { h, env } = home();
  const folder = join(h, "Downloads", "dbg_abc");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "session.jsonl.gz"), gzipSync(claudeSession()));
  writeFileSync(join(folder, "session__subagents__agent-sub1.jsonl.gz"), gzipSync(subagent()));
  writeFileSync(join(folder, "environment.json"), JSON.stringify({ harness: "claude-code", sessionId: id }));
  const res = run(env, "import", folder);
  assert.equal(res.status, 0, res.stderr);
  const s = JSON.parse(readFileSync(join(h, ".proto", "traces", id, "summary.json"), "utf8"));
  assert.equal(s.counts.subagents, 1);
  assert.equal(s.counts.errors, 3);
});

test("a step counts as a kit tool only when it runs one", async () => {
  const { groupOf } = await import("./trace-read.mjs");
  const g = (command) => groupOf({ name: "Bash", input: { command } });
  assert.equal(g("node ~/kit/tools/proto-build.mjs b1 --codebase c"), "proto proto-build");
  assert.equal(g('cd /x && node "$K/tools/build-stream.mjs" phase read'), "proto build-stream phase");
  assert.equal(g("node --test tools/debug-report.test.mjs"), "Bash");
  assert.equal(g("head -60 tools/serve.mjs"), "Bash");
  assert.equal(g("python3 - <<'EOF'\ns = 'node tools/migrate-rig.mjs plan'\nEOF"), "Bash");
  assert.equal(g("for i in $(seq 1 20); do curl -s x | grep -q ok && break; sleep 15; done"), "Bash (sleep/poll)");
  assert.equal(groupOf({ name: "shell", input: { command: "bash -lc 'node ~/kit/tools/serve.mjs --slug s'" } }), "proto serve");
  assert.equal(groupOf({ name: "AskUserQuestion", input: {} }), "waiting on the person");
});

test("a poll that runs every round is flagged as never seeing its condition", () => {
  const { h, env } = home();
  const base = { sessionId: id, cwd: "/work" };
  const transcript = join(h, ".claude", "projects", "-work", `${id}.jsonl`);
  mkdirSync(dirname(transcript), { recursive: true });
  writeFileSync(transcript, jsonl([
    { ...base, type: "user", timestamp: t(0), message: { content: "deploy and check ~/.proto/x" } },
    { ...base, type: "assistant", timestamp: t(1), requestId: "r1", message: { content: [{ type: "tool_use", id: "p1", name: "Bash", input: { command: "for i in $(seq 1 4); do vercel ls 2>/dev/null | grep -q Ready && break; sleep 15; done" } }] } },
    { ...base, type: "user", timestamp: t(62), message: { content: [{ type: "tool_result", tool_use_id: "p1", content: "https://a.vercel.app" }] } },
  ]));
  assert.equal(run(env, "import", id).status, 0);
  const s = JSON.parse(readFileSync(join(h, ".proto", "traces", id, "summary.json"), "utf8"));
  const cap = s.struggles.find((x) => x.kind === "poll-cap");
  assert.ok(cap, JSON.stringify(s.struggles));
  assert.deepEqual(cap.steps, [1]);
});
