import { test } from "node:test";
import assert from "node:assert/strict";
import { copyGateQuestion, missingParts, passGate } from "./copy-gate.mjs";
import { questionEvent } from "./questions.mjs";
import { copyForecast } from "./tail.mjs";

const tree = {
  nodes: [
    { id: "n1", raw: "nav.sidebar", rect: { x: 0, y: 0, w: 200, h: 800 } },
    { id: "n2", raw: "header", rect: { x: 200, y: 0, w: 1000, h: 80 } },
    { id: "n3", raw: "div.hero > img", rect: { x: 200, y: 80, w: 1000, h: 400 } },
    { id: "n4", raw: "main", rect: { x: 200, y: 480, w: 1000, h: 320 } },
  ],
  curation: [
    { id: "n1", name: "Sidebar", role: "leaf" },
    { id: "n2", name: "Top bar", role: "leaf" },
    { id: "n3", name: "Hero picture", role: "leaf" },
    { id: "n4", name: "Feed", role: "leaf" },
  ],
};

/** A replicate result with these parts matched; over the gate unless every part matched. */
function copyWith(matched) {
  const parts = tree.nodes.map((node) => ({ id: node.id, slug: node.id, status: matched.includes(node.id) ? "matched" : "differs" }));
  const proceed = matched.length === tree.nodes.length;
  return { parts, gate: { proceed, line: proceed ? "Usable now" : "the copy is not usable yet" } };
}

function harness({ copies, answers }) {
  const calls = [];
  let clock = 0;
  return {
    calls,
    deps: {
      tree,
      copy: async () => {
        calls.push("copy");
        clock += 45_000;
        return copies.shift();
      },
      settle: async () => {
        calls.push("settle");
        clock += 3_000;
      },
      ask: async (fields) => {
        const event = questionEvent({ ...fields, id: "q-1" });
        assert.ok(!(event instanceof Error), event.message);
        calls.push({ ask: fields });
        return "q-1";
      },
      wait: async () => answers.shift(),
      now: () => clock,
    },
  };
}

test("a copy within its gate goes straight on", async () => {
  const { calls, deps } = harness({ copies: [], answers: [] });
  const gated = await passGate({ ...deps, replicated: copyWith(["n1", "n2", "n3", "n4"]) });
  assert.equal(gated.outcome, "proceed");
  assert.deepEqual(calls, []);
});

test("over the gate, the copy is retried once by itself and passes without asking", async () => {
  const { calls, deps } = harness({ copies: [copyWith(["n1", "n2", "n3", "n4"])], answers: [] });
  const gated = await passGate({ ...deps, replicated: copyWith(["n2"]) });
  assert.equal(gated.outcome, "proceed");
  assert.deepEqual(calls, ["settle", "copy"]);
});

test("still over after the retry, the person is asked the copy-gate question; build goes on", async () => {
  const { calls, deps } = harness({ copies: [copyWith(["n2", "n4"])], answers: [{ by: "option", option: "build" }] });
  const gated = await passGate({ ...deps, replicated: copyWith(["n2"]) });
  assert.equal(gated.outcome, "build");
  assert.deepEqual(calls.slice(0, 2), ["settle", "copy"]);
  const { ask } = calls[2];
  assert.equal(ask.form, "copy-gate");
  assert.deepEqual(ask.options.map((o) => o.label), ["Not yet, finish it", "Yes, start building"]);
  assert.equal(ask.defaultAfterSeconds, 30);
  // n2 and n4 matched: 80 000 + 320 000 of 960 000 px.
  assert.equal(ask.copied, 42);
  assert.deepEqual(ask.missing, ["n3", "n1"], "largest first");
  assert.equal(ask.recommended, "finish", "the retry gained a lot: another pass helps");
  assert.deepEqual(ask.suggestions, ["Finish only the Hero picture", "Skip the Hero picture", "Use a placeholder image"]);
  assert.match(ask.impact, /They'll be empty spaces, and your change is built around them\. Finishing the copy takes about a minute more\.$/);
});

test("finish runs another copy pass; a reply comes back as the instruction", async () => {
  const { calls, deps } = harness({
    copies: [copyWith(["n2"]), copyWith(["n2"])],
    answers: [{ by: "option", option: "finish" }, { by: "reply", text: "Skip the sidebar" }],
  });
  const gated = await passGate({ ...deps, replicated: copyWith(["n2"]) });
  assert.equal(gated.outcome, "reply");
  assert.equal(gated.answer.text, "Skip the sidebar");
  assert.deepEqual(calls.filter((call) => typeof call === "string"), ["settle", "copy", "copy"]);
  const asks = calls.filter((call) => call.ask).map((call) => call.ask);
  assert.equal(asks.length, 2);
  assert.equal(asks[0].recommended, "build", "the retry gained nothing: start building");
});

test("the forecast: another pass helps only when the last one gained enough", () => {
  assert.equal(copyForecast({ before: 0.5, after: 0.7, passMs: 50_000 }).verdict, "another-pass-helps");
  assert.equal(copyForecast({ before: 0.5, after: 0.51, passMs: 50_000 }).verdict, "little-gain");
  assert.equal(copyForecast({ before: 0.5, after: 0.7, passMs: 150_000 }).minutes, 3);
});

test("the question without missing parts still says what starting now means", () => {
  const fields = copyGateQuestion({ copied: 1, missing: [], forecast: { verdict: "little-gain", minutes: 2 } });
  assert.equal(fields.copied, 100);
  assert.deepEqual(fields.suggestions, []);
  assert.match(fields.impact, /won't match yours yet\. Finishing the copy takes about 2 minutes more\.$/);
  assert.deepEqual(missingParts(copyWith(["n1", "n2", "n3", "n4"]), tree), []);
});
