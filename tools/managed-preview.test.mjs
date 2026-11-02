import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyManagedBuild } from "./managed-preview.mjs";

test("managed preview verifies bytes and rejects stale or remote content without launching a server", async () => {
  const folder = mkdtempSync(join(tmpdir(), "managed-preview-test-"));
  try {
    writeFileSync(join(folder, "index.html"), "prepared");
    await verifyManagedBuild(folder, "http://localhost:5173", async () => new Response("prepared"));
    await assert.rejects(verifyManagedBuild(folder, "http://localhost:5173", async () => new Response("stale")), /differs/);
    await assert.rejects(verifyManagedBuild(folder, "https://example.com", () => { throw Error("must not fetch"); }), /localhost/);
    await assert.rejects(verifyManagedBuild(folder, "http://localhost:5173", async () => new Response("missing", { status: 404 })), /differs/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
