import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repairReferenceServing } from "./repair-reference-serving.mjs";

test("old configs serve references while preserving workspace settings; repair is idempotent", t => {
  const ws = mkdtempSync(join(tmpdir(), "reference-serving-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const current = readFileSync(new URL("../template/workspace-react/vite.config.ts", import.meta.url), "utf8");
  const old = current.replace("previews|wireframes|references", "previews|wireframes") + "\n// custom workspace settings\n";
  const file = join(ws, "vite.config.ts");
  writeFileSync(file, old);
  assert.equal(repairReferenceServing(ws).changed, true);
  const fixed = readFileSync(file, "utf8");
  assert.equal(fixed, current + "\n// custom workspace settings\n");
  const literal = fixed.match(/const PUBLISHED = (.+);/)[1];
  const pattern = new RegExp(literal.slice(1, -1));
  assert.ok(pattern.test("/references/added-after-start.webp"));
  assert.ok(pattern.test("/previews/example.svg"));
  assert.ok(!pattern.test("/src/App.tsx"));
  assert.equal(repairReferenceServing(ws).changed, false);
});

test("missing and custom configs are left alone", t => {
  const ws = mkdtempSync(join(tmpdir(), "reference-serving-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  assert.equal(repairReferenceServing(ws).changed, false);
  const file = join(ws, "vite.config.ts");
  const source = "export default { plugins: [] };";
  writeFileSync(file, source);
  assert.equal(repairReferenceServing(ws).changed, false);
  assert.equal(readFileSync(file, "utf8"), source);
});
