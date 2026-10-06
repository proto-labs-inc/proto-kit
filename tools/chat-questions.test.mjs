import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answeredInTerminal, ask, CHAT_PROGRESS_TIMEOUT_MS, waitForAnswer } from "./ask.mjs";
import { keepChatQuestion, readChatQuestion } from "./chat-questions.mjs";
import { passGate } from "./copy-gate.mjs";

const fields = {
  form: "generic", text: "Which layout should I build?",
  options: [{ id: "compact", label: "Compact" }, { id: "wide", label: "Wide" }],
  recommended: "compact",
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "proto-chat-questions-"));
  return { root, build: { codebase: "cb-test", briefId: "brief-test", runDir: join(root, "run", "builds", "brief-test"), sink: "file" } };
}

test("chat questions return promptly with stable IDs and no site controls or countdown", async () => {
  const { root, build } = fixture();
  const began = Date.now();
  const id = await ask(build, fields);
  assert.equal(await ask(build, fields), id);
  const pending = await waitForAnswer(build, id);
  assert.ok(Date.now() - began < 1000, "does not wait for the five-second default");
  assert.equal(pending.status, "needs-input");
  assert.equal(pending.briefId, build.briefId);
  assert.equal(pending.questionId, id);
  assert.deepEqual(pending.question.options, fields.options);
  assert.equal(pending.question.recommended, "compact");
  assert.equal(pending.question.defaultAfterSeconds, undefined);
  assert.match(pending.message, /answer in this conversation/);
  assert.equal(readFileSync(join(build.runDir, "events.jsonl"), "utf8").trim().split("\n").length, 1, "read-only history is recorded once");
  assert.equal(readdirSync(join(build.runDir, "questions")).length, 2);
  assert.deepEqual(await waitForAnswer(build, id), pending);
});

test("chat answers validate options and text, persist once, and reject conflicting replies", async () => {
  const { build } = fixture();
  const id = await ask(build, fields);
  await assert.rejects(answeredInTerminal(build, id, { option: "other" }), /unknown option/);
  await assert.rejects(answeredInTerminal(build, id, { text: " " }), /answer text/);
  await assert.rejects(answeredInTerminal(build, id, { text: "wide", option: "wide" }), /exactly one/);
  const answer = await answeredInTerminal(build, id, { option: "wide" });
  assert.deepEqual(answer, { by: "option", option: "wide" });
  const path = join(build.runDir, "questions", `${id}.answer.json`);
  const saved = readFileSync(path, "utf8");
  assert.deepEqual(await answeredInTerminal(build, id, { option: "wide" }), answer);
  assert.equal(readFileSync(path, "utf8"), saved);
  await assert.rejects(answeredInTerminal(build, id, { option: "compact" }), /already has a different answer/);
  assert.deepEqual(await waitForAnswer(build, id), answer);
  assert.equal(await ask(build, fields), id, "rerunning question creation does not discard an accepted answer");
  assert.deepEqual(await waitForAnswer({ ...build, harness: "claude", env: {} }, id), answer, "a persisted chat question keeps its return path");
  const second = await ask({ ...build, questionKey: "second-question" }, fields);
  assert.notEqual(second, id);
  assert.deepEqual(await answeredInTerminal(build, second, { text: " Keep the narrow version " }), { by: "reply", text: "Keep the narrow version" });
});

test("stable question keys cannot silently change questions or cross build identities", () => {
  const { build } = fixture();
  const keyed = { ...build, questionKey: "layout" };
  const id = keepChatQuestion(keyed, fields);
  assert.throws(() => keepChatQuestion(keyed, { ...fields, text: "A different choice?" }), /already names a different question/);
  assert.throws(() => readChatQuestion({ ...build, briefId: "other" }, id), /different build/);
  assert.throws(() => readChatQuestion(build, "../../escape"), /invalid question id/);
});

test("a hanging site cannot block chat questions or persisted answers", async (t) => {
  const { build } = fixture();
  const live = { ...build, sink: "site", progressTarget: { app: "https://fixture.invalid", secret: null } };
  const signals = [];
  t.mock.method(globalThis, "fetch", (_url, { signal }) => {
    signals.push(signal);
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const began = Date.now();
  const id = await ask(live, fields);
  assert.ok(Date.now() - began < CHAT_PROGRESS_TIMEOUT_MS + 1000);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal((await waitForAnswer(live, id)).status, "needs-input");
  const answer = await answeredInTerminal(live, id, { option: "compact" });
  assert.ok(Date.now() - began < 2 * CHAT_PROGRESS_TIMEOUT_MS + 1000);
  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => signal.aborted), true);
  assert.deepEqual(await waitForAnswer(live, id), answer);
  assert.deepEqual(await answeredInTerminal(live, id, { option: "compact" }), answer);
  assert.equal(signals.length, 3, "replaying an answer retries only history, without resetting a later question's status");
  assert.deepEqual(readdirSync(build.runDir).sort(), ["events.jsonl", "outbox", "questions"], "progress failure leaves local history and interaction intact");
});

test("structured question and answer history is sent once after successful delivery", async (t) => {
  const { build } = fixture();
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, { body }) => {
    calls.push(JSON.parse(body).params);
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "{}" }] } }), { headers: { "content-type": "application/json" } });
  });
  const live = { ...build, sink: "site", progressTarget: { app: "https://fixture.invalid", secret: null } };
  const id = await ask(live, fields);
  await ask(live, fields);
  await answeredInTerminal(live, id, { option: "wide" });
  await answeredInTerminal(live, id, { option: "wide" });
  const events = calls.filter((call) => call.name === "report_build_events").flatMap((call) => call.arguments.events);
  assert.deepEqual(events.map((event) => event.kind), ["question", "answered"]);
  assert.deepEqual(events[0].options, fields.options);
  assert.equal(events[1].questionId, id);
  assert.equal(events[1].option, "wide");
});

test("an outbound client that ignores abort still cannot hold a chat question", async (t) => {
  const { build } = fixture();
  t.mock.method(globalThis, "fetch", () => new Promise(() => {}));
  const began = Date.now();
  const id = await ask({ ...build, sink: "site", progressTarget: { app: "https://fixture.invalid", secret: null } }, fields);
  assert.ok(Date.now() - began < CHAT_PROGRESS_TIMEOUT_MS + 700);
  assert.equal((await waitForAnswer(build, id)).status, "needs-input");
});

test("offline question history is acknowledged before the separately submitted answer", async (t) => {
  const { build } = fixture();
  const id = await ask(build, fields); // Local/offline question, never acknowledged.
  const saved = [];
  t.mock.method(globalThis, "fetch", async (_url, { body }) => {
    const call = JSON.parse(body).params;
    if (call.name === "report_build_events") {
      const events = call.arguments.events;
      assert.equal(events.length, 1, "Cloud rejects answers mixed with other events");
      if (events[0].kind === "answered") assert.equal(saved[0]?.kind, "question", "Cloud requires the question to be stored first");
      saved.push(events[0]);
    }
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: "{}" }] } }), { headers: { "content-type": "application/json" } });
  });
  const live = { ...build, sink: "site", progressTarget: { app: "https://fixture.invalid", secret: null } };
  await answeredInTerminal(live, id, { option: "wide" });
  await answeredInTerminal(live, id, { option: "wide" });
  assert.deepEqual(saved.map((event) => event.kind), ["question", "answered"]);
});

const tree = { nodes: [{ id: "n1", raw: "main", rect: { w: 100, h: 100 } }], curation: [{ id: "n1", name: "Main", role: "leaf" }] };
const incomplete = { parts: [{ id: "n1", slug: "main", status: "differs" }], gate: { proceed: false, line: "Still differs" } };

test("copy gate resumes pending and answered checkpoints without repeating capture or replication", async () => {
  const { build } = fixture();
  let checkpoint;
  let copies = 0;
  let settles = 0;
  const deps = {
    replicated: incomplete, tree,
    copy: async () => { copies += 1; return incomplete; },
    settle: async () => { settles += 1; },
    ask: (question, questionKey) => ask({ ...build, questionKey }, question),
    wait: (id) => waitForAnswer(build, id),
    save: (record) => { checkpoint = structuredClone(record); },
  };
  const first = await passGate(deps);
  assert.equal(first.outcome, "needs-input");
  assert.equal(first.pending.question.copied, 0);
  assert.deepEqual(first.pending.question.missing, ["n1"]);
  assert.equal(copies, 1);
  assert.equal(settles, 1);
  const again = await passGate({ ...deps, checkpoint });
  assert.equal(again.pending.questionId, first.pending.questionId);
  assert.equal(copies, 1);
  assert.equal(settles, 1);
  await answeredInTerminal(build, first.pending.questionId, { option: "build" });
  const answered = await passGate({ ...deps, checkpoint });
  assert.equal(answered.outcome, "build");
  assert.equal(copies, 1);
  assert.equal(settles, 1);
  assert.deepEqual(await passGate({ ...deps, checkpoint }), answered);
});

test("finish creates one further pass and a new stable question, then a free-text instruction resumes", async () => {
  const { build } = fixture();
  let checkpoint;
  let copies = 0;
  const deps = {
    replicated: incomplete, tree, copy: async () => { copies += 1; return incomplete; }, settle: async () => {},
    ask: (question, questionKey) => ask({ ...build, questionKey }, question), wait: (id) => waitForAnswer(build, id),
    save: (record) => { checkpoint = structuredClone(record); },
  };
  const first = await passGate(deps);
  await answeredInTerminal(build, first.pending.questionId, { option: "finish" });
  const second = await passGate({ ...deps, checkpoint });
  assert.equal(copies, 2);
  assert.notEqual(first.pending.questionId, second.pending.questionId);
  const retry = await passGate({ ...deps, checkpoint });
  assert.equal(copies, 2);
  assert.equal(retry.pending.questionId, second.pending.questionId);
  await answeredInTerminal(build, second.pending.questionId, { text: "Skip the footer and continue" });
  const result = await passGate({ ...deps, checkpoint });
  assert.equal(result.outcome, "reply");
  assert.equal(result.answer.text, "Skip the footer and continue");
  assert.equal(copies, 2);
});
