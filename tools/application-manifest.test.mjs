import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeApplicationManifest } from "./application-manifest.mjs";

test("application manifest keeps independent sets when a preview port changes", () => {
  const root = mkdtempSync(join(tmpdir(), "proto-app-manifest-"));
  try {
    mkdirSync(join(root, "app"));
    const record = { worktree: root, appRoot: "app", slug: "billing" };
    const rows = [
      { id: "header", title: "Header", version_id: "first", version_title: "Compact" },
      { id: "footer", title: "Footer", version_id: "second", version_title: "Expanded" },
    ];
    writeApplicationManifest(record, "https://proto.invalid", 5201, rows);
    const { manifest } = writeApplicationManifest(record, "https://proto.invalid", 5202);
    assert.equal(manifest.port, 5202);
    assert.deepEqual(manifest.variantSets.map(set => set.component), ["header", "footer"]);
    assert.deepEqual(manifest.variantSets[0].variants.map(version => version.id), ["original", "first"]);
    assert.deepEqual(manifest.states, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
