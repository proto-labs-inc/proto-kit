import { test } from "node:test";
import assert from "node:assert/strict";
import { questionEvent } from "./questions.mjs";

const fields = { id: "q-test", form: "generic", text: "Which direction?", options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }], recommended: "a" };
test("neutral question schema retains choices, copy details, and read-only history shape", () => {
  assert.deepEqual(questionEvent(fields), { kind: "question", ...fields });
  const gate = questionEvent({ ...fields, form: "copy-gate", copied: 72, missing: ["n4"] });
  assert.equal(gate.copied, 72);
  assert.deepEqual(gate.missing, ["n4"]);
});
test("invalid question choices and incomplete copy gates are rejected", () => {
  assert.match(questionEvent({ ...fields, options: [{ id: "a", label: "Only one" }] }).message, /2 or 3 options/);
  assert.match(questionEvent({ ...fields, recommended: "other" }).message, /recommended/);
  assert.match(questionEvent({ ...fields, form: "copy-gate" }).message, /copied and --missing/);
});
