import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepFolder, restoreFolder } from "./unit-restore.mjs";

// A part folder as replicate wrote it, and a run folder to keep it under.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "unit-restore-"));
  const folder = join(root, "src", "parts", "activity-list");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "ActivityList.tsx"), "<ul><li>one</li><li>two</li><li>three</li></ul>\n");
  writeFileSync(join(folder, "component.json"), '{"states":[]}\n');
  return { folder, runDir: join(root, "build") };
}

test("the first keep is the one that counts, and restore puts the folder back exactly", () => {
  const { folder, runDir } = fixture();
  assert.equal(keepFolder({ folder, slug: "activity-list", runDir }).kept, true);
  // A fixer deletes list items to quiet the diff and leaves a tag open; a later keep changes nothing.
  writeFileSync(join(folder, "ActivityList.tsx"), "<ul><li>one</ul>\n");
  rmSync(join(folder, "component.json"));
  assert.equal(keepFolder({ folder, slug: "activity-list", runDir }).kept, false);
  const back = restoreFolder({ folder, slug: "activity-list", runDir });
  assert.equal(back.restored, true);
  assert.equal(readFileSync(join(folder, "ActivityList.tsx"), "utf8"), "<ul><li>one</li><li>two</li><li>three</li></ul>\n");
  assert.ok(existsSync(join(folder, "component.json")));
});

test("restore without a kept copy changes nothing", () => {
  const { folder, runDir } = fixture();
  assert.deepEqual(restoreFolder({ folder, slug: "activity-list", runDir }), { restored: false, path: null });
  assert.ok(existsSync(join(folder, "ActivityList.tsx")));
});
