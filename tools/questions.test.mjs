import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The feed lives under $HOME/.proto: point it at a throwaway home.
process.env.HOME = mkdtempSync(join(tmpdir(), "questions-test-"));
const { answerCommand, awaitAnswer, committedOffset, markAsked, questionEvent, routeAnswer, takenLines } = await import("./questions.mjs");
const { waiting } = await import("./tail.mjs");

const courier = (codebase) => join(process.env.HOME, ".proto", codebase, "run", "courier");
function feed(codebase, command) {
  mkdirSync(courier(codebase), { recursive: true });
  appendFileSync(join(courier(codebase), "commands.jsonl"), JSON.stringify(command) + "\n");
  return readFileSync(join(courier(codebase), "commands.jsonl")).length;
}

/** A clock the test moves: sleeping advances it and runs what the feed should receive at that moment. */
function clock(at = 1_000_000) {
  const due = [];
  return {
    now: () => at,
    at: (ms, work) => due.push({ ms: at + ms, work }),
    sleep: async (ms) => {
      at += ms;
      for (const item of due.filter((d) => d.ms <= at)) {
        due.splice(due.indexOf(item), 1);
        item.work();
      }
    },
  };
}

const COPY_GATE = {
  id: "q-1",
  form: "copy-gate",
  text: "Start building before the copy is finished?",
  impact: "If you start now, your prototype won't show them yet.",
  options: [
    { id: "finish", label: "Not yet, finish it" },
    { id: "build", label: "Yes, start building" },
  ],
  recommended: "finish",
  defaultAfterSeconds: 30,
  suggestions: ["Finish only the Sidebar", "Skip the Sidebar"],
  copied: 83,
  missing: ["n4", "n9"],
};

test("a copy-gate question has the shape the site stores", () => {
  const event = questionEvent(COPY_GATE);
  assert.deepEqual(event, { kind: "question", ...COPY_GATE });
});

test("a question the site would refuse names every reason", () => {
  const refused = questionEvent({ id: "q-2", form: "copy-gate", text: "Go?", options: [{ id: "Go", label: "Go" }], defaultAfterSeconds: 2 });
  assert.ok(refused instanceof Error);
  for (const reason of ["2 or 3 options", 'option id "Go"', "5 to 600", "needs --recommended", "--copied and --missing"]) {
    assert.match(refused.message, new RegExp(reason.replace(/[-]/g, "\\-")));
  }
  const unknown = questionEvent({ ...COPY_GATE, recommended: "later" });
  assert.match(unknown.message, /--recommended must be one of the options/);
});

test("the courier takes an answer whole and nothing else", () => {
  assert.deepEqual(answerCommand({ run: "answer", briefId: "b1", questionId: "q-1", option: "build", extra: 1 }), { run: "answer", briefId: "b1", questionId: "q-1", option: "build" });
  assert.deepEqual(answerCommand({ run: "answer", briefId: "b1", questionId: "q-1", text: "  skip it " }), { run: "answer", briefId: "b1", questionId: "q-1", text: "skip it" });
  assert.deepEqual(answerCommand({ run: "answer", briefId: "b1", questionId: "q-1", hold: true }), { run: "answer", briefId: "b1", questionId: "q-1", hold: true });
  assert.equal(answerCommand({ run: "answer", briefId: "b1", questionId: "q-1", option: "build", text: "both" }), null);
  assert.equal(answerCommand({ run: "answer", briefId: "b1", questionId: "q-1" }), null);
  assert.equal(answerCommand({ run: "answer", questionId: "q-1", hold: true }), null);
});

test("await-answer returns the answer that arrives, and commits it when nothing before it waits", async () => {
  const time = clock();
  const start = feed("cb1", { id: "c1", run: "create-prototype", briefId: "b1" });
  writeFileSync(join(courier("cb1"), "offset.json"), JSON.stringify({ offset: start }));
  markAsked("cb1", { briefId: "b1", questionId: "q-1", recommended: "finish", defaultAfterSeconds: 30 }, time.now());
  time.at(2_000, () => feed("cb1", { id: "c2", run: "answer", briefId: "b1", questionId: "q-1", option: "build" }));
  const sent = [];
  const answer = await awaitAnswer({ codebase: "cb1", briefId: "b1", questionId: "q-1", sendDefault: async (option) => (sent.push(option), { kind: "sent" }), now: time.now, sleep: time.sleep });
  assert.deepEqual(answer, { by: "option", option: "build" });
  assert.deepEqual(sent, [], "an answer from the site is never repeated to it");
  assert.equal(committedOffset("cb1"), readFileSync(join(courier("cb1"), "commands.jsonl")).length);
  assert.equal(existsSync(join(courier("cb1"), "awaiting", "q-1.json")), false);
});

test("a hold stops the countdown; the answer after it is the one", async () => {
  const time = clock();
  markAsked("cb2", { briefId: "b2", questionId: "q-1", recommended: "finish", defaultAfterSeconds: 30 }, time.now());
  time.at(5_000, () => feed("cb2", { id: "c1", run: "answer", briefId: "b2", questionId: "q-1", hold: true }));
  time.at(90_000, () => feed("cb2", { id: "c2", run: "answer", briefId: "b2", questionId: "q-1", text: "Skip the Sidebar" }));
  const lines = [];
  const answer = await awaitAnswer({ codebase: "cb2", briefId: "b2", questionId: "q-1", sendDefault: async () => assert.fail("a held question never defaults"), log: (line) => lines.push(line), now: time.now, sleep: time.sleep });
  assert.deepEqual(answer, { by: "reply", text: "Skip the Sidebar" });
  assert.match(lines.join("\n"), /countdown is held/);
});

test("with no answer and no hold, the recommended option is taken when the countdown ends", async () => {
  const time = clock();
  markAsked("cb3", { briefId: "b3", questionId: "q-1", recommended: "finish", defaultAfterSeconds: 30 }, time.now());
  const sent = [];
  const answer = await awaitAnswer({ codebase: "cb3", briefId: "b3", questionId: "q-1", sendDefault: async (option) => (sent.push({ option, at: time.now() }), { kind: "sent" }), now: time.now, sleep: time.sleep });
  assert.deepEqual(answer, { by: "default", option: "finish" });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].at >= 1_000_000 + 30_000 && sent[0].at < 1_000_000 + 31_000);
});

test("a default the site refuses waits for the answer that beat it", async () => {
  const time = clock();
  markAsked("cb4", { briefId: "b4", questionId: "q-1", recommended: "finish", defaultAfterSeconds: 30 }, time.now());
  time.at(31_000, () => feed("cb4", { id: "c1", run: "answer", briefId: "b4", questionId: "q-1", option: "build" }));
  const answer = await awaitAnswer({ codebase: "cb4", briefId: "b4", questionId: "q-1", sendDefault: async () => ({ kind: "already-answered", winner: null }), now: time.now, sleep: time.sleep });
  assert.deepEqual(answer, { by: "option", option: "build" });
});

test("a default the site refuses with the winning answer goes with that answer, and its command is taken quietly", async () => {
  const time = clock();
  markAsked("cb8", { briefId: "b8", questionId: "q-1", recommended: "finish", defaultAfterSeconds: 30 }, time.now());
  const answer = await awaitAnswer({ codebase: "cb8", briefId: "b8", questionId: "q-1", sendDefault: async () => ({ kind: "already-answered", winner: { by: "reply", text: "Skip it" } }), now: time.now, sleep: time.sleep });
  assert.deepEqual(answer, { by: "reply", text: "Skip it" });
  const late = feed("cb8", { id: "c1", run: "answer", briefId: "b8", questionId: "q-1", text: "Skip it" });
  const routed = routeAnswer("cb8", late);
  assert.equal(routed.route, "taken");
  assert.equal(committedOffset("cb8"), late);
});

test("answers to other questions stay in the feed for the listen skill", async () => {
  const time = clock();
  const other = feed("cb5", { id: "c1", run: "answer", briefId: "b5", questionId: "q-other", option: "build" });
  markAsked("cb5", { briefId: "b5", questionId: "q-1" }, time.now());
  time.at(1_000, () => feed("cb5", { id: "c2", run: "answer", briefId: "b5", questionId: "q-1", option: "finish" }));
  const answer = await awaitAnswer({ codebase: "cb5", briefId: "b5", questionId: "q-1", sendDefault: async () => ({ kind: "sent" }), now: time.now, sleep: time.sleep });
  assert.deepEqual(answer, { by: "option", option: "finish" });
  assert.equal(takenLines("cb5").has(other), false);
  assert.equal(committedOffset("cb5"), 0, "the line before the taken one is still the listen skill's");
});

test("a stray answer is dropped with one line; an awaited one is left to its build", () => {
  const stray = feed("cb6", { id: "c1", run: "answer", briefId: "b6", questionId: "q-gone", option: "build" });
  const routed = routeAnswer("cb6", stray);
  assert.equal(routed.route, "dropped");
  assert.match(routed.line, /no build is waiting on it: dropped/);
  assert.equal(committedOffset("cb6"), stray);
  markAsked("cb6", { briefId: "b6", questionId: "q-live" });
  const awaited = feed("cb6", { id: "c2", run: "answer", briefId: "b6", questionId: "q-live", option: "build" });
  assert.equal(routeAnswer("cb6", awaited).route, "awaited");
  assert.equal(committedOffset("cb6"), stray);
});

test("an answer in the feed is not a site command waiting", () => {
  feed("cb7", { id: "c1", run: "answer", briefId: "b7", questionId: "q-1", hold: true });
  assert.deepEqual(waiting("cb7"), { waiting: false, what: null });
  feed("cb7", { id: "c2", run: "create-prototype", briefId: "b8" });
  assert.equal(waiting("cb7").waiting, true);
});
