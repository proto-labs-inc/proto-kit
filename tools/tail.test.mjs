import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tail reads under $HOME/.proto: point it at a throwaway home.
process.env.HOME = mkdtempSync(join(tmpdir(), "tail-test-"));
const { decide, handlingFile, readRecords, record, tailFile, waiting } = await import("./tail.mjs");

function courier(codebase, lines) {
  const run = join(process.env.HOME, ".proto", codebase, "run", "courier");
  mkdirSync(run, { recursive: true });
  const text = lines.map((line) => JSON.stringify(line) + "\n").join("");
  writeFileSync(join(run, "commands.jsonl"), text);
  return { run, size: Buffer.byteLength(text, "utf8") };
}

test("the command being handled does not count as waiting", () => {
  const { run, size } = courier("cb1", [{ id: "c1", run: "create-prototype", briefId: "b1" }]);
  writeFileSync(join(run, "offset.json"), JSON.stringify({ offset: 0 }));
  assert.equal(waiting("cb1").waiting, true, "an uncommitted, unmarked line waits");
  writeFileSync(handlingFile("cb1"), JSON.stringify({ offset: size }));
  assert.deepEqual(waiting("cb1"), { waiting: false, what: null });
});

test("a command that arrives behind the one in hand does wait", () => {
  const first = courier("cb2", [{ id: "c1", run: "create-prototype" }]);
  writeFileSync(handlingFile("cb2"), JSON.stringify({ offset: first.size }));
  courier("cb2", [{ id: "c1", run: "create-prototype" }, { id: "c2", run: "import-design-system" }]);
  const queued = waiting("cb2");
  assert.equal(queued.waiting, true);
  assert.equal(queued.what, "an import-design-system command from the site");
  assert.equal(queued.count, 1);
});

test("decide answers at once before the checkpoint and does not ask anyone to wait", () => {
  const file = tailFile("cb3");
  record(file, { kind: "phase", phase: "import-tail", items: [{ item: "a", weight: 1, matched: true }, { item: "b", weight: 1 }] });
  const decision = decide(readRecords(file), "cb3");
  assert.equal(decision.action, "continue");
  assert.match(decision.line, /^Fixing in the background: 1 of 2 matched; nothing waits on the rest\.$/);
});
