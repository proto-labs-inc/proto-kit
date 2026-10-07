import { test } from "node:test";
import assert from "node:assert/strict";
import { versionProblem } from "./check-version-bump.mjs";

const OLD = "0.1.0+codex.20261007002610";
const NEW = "0.1.0+codex.20261007083616";

test("a change with a newer version passes", () => {
  assert.equal(versionProblem({ before: OLD, after: NEW, changed: ["tools/mobbin.mjs", ".codex-plugin/plugin.json"] }), null);
});

test("a change that keeps the version fails and says what to do", () => {
  const problem = versionProblem({ before: OLD, after: OLD, changed: ["skills/setup/SKILL.md"] });
  assert.match(problem, /still says 0\.1\.0\+codex\.20261007002610/);
  assert.match(problem, /AGENTS\.md/);
});

test("a version that goes backwards or is malformed fails", () => {
  assert.match(versionProblem({ before: NEW, after: OLD, changed: ["x"] }), /must move forward/);
  assert.match(versionProblem({ before: OLD, after: "0.1.1", changed: ["x"] }), /is not 0\.1\.0\+codex/);
});

test("nothing changed is fine", () => {
  assert.equal(versionProblem({ before: OLD, after: OLD, changed: [] }), null);
});
