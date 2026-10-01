import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

test("question CLI round-trips an explicit chat answer without another process or remote feed", () => {
  const home = mkdtempSync(join(tmpdir(), "build-question-cli-"));
  const tool = join(dirname(fileURLToPath(import.meta.url)), "build-stream.mjs");
  const run = (...args) => {
    const result = spawnSync(process.execPath, [tool, ...args, "--codebase", "fixture", "--no-send"], { encoding: "utf8", timeout: 3000, env: { ...process.env, HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const first = run("question", "brief", "Which direction?", "--kind", "generic", "--option", "a=First", "--option", "b=Second");
  assert.equal(first.status, "needs-input");
  assert.equal(run("question", "brief", "Which direction?", "--kind", "generic", "--option", "a=First", "--option", "b=Second").questionId, first.questionId);
  assert.deepEqual(run("answered", "brief", first.questionId, "--option", "b"), { by: "option", option: "b" });
  assert.deepEqual(run("await-answer", "brief", first.questionId), { by: "option", option: "b" });
  assert.equal(existsSync(join(home, ".proto", "fixture", "run", "courier")), false);
  assert.deepEqual(readdirSync(join(home, ".proto", "fixture", "run")), ["builds"]);
});
