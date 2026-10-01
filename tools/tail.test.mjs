import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, readRecords, record, tailFile } from "./tail.mjs";

test("local quality decisions ignore all stale remote command files", () => {
  const previous = process.env.HOME;
  const root = mkdtempSync(join(tmpdir(), "local-tail-"));
  process.env.HOME = root;
  try {
    const legacy = join(root, ".proto", "fixture", "run", "courier");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "commands.jsonl"), '{"run":"create-prototype"}\n');
    const file = tailFile("fixture");
    record(file, { kind: "phase", items: [{ item: "a", weight: 1, matched: true }, { item: "b", weight: 1 }] });
    const result = decide(readRecords(file), "fixture");
    assert.equal(result.action, "continue");
    assert.equal(result.matched, 1);
    assert.equal(result.total, 2);
  } finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
});
