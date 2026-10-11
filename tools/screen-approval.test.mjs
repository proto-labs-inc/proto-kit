import test from "node:test";
import assert from "node:assert/strict";
import { requireScreenApproval } from "./screen-approval.mjs";
const request = { indexId: "index", version: 3, entryId: "entry" };
const response = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});
test("replication checks the exact approved run, version and included state", async () => {
  await requireScreenApproval("project", request, async (name, args) => {
    assert.equal(name, "screen_index");
    assert.deepEqual(args, {
      operation: "replication-check",
      codebase: "project",
      ...request,
    });
    return response({ approved: true, ...request });
  });
  for (const approval of [
    { approved: false, ...request },
    { approved: true, ...request, version: 2 },
    { approved: true, ...request, entryId: "other" },
  ]) {
    await assert.rejects(
      requireScreenApproval("project", request, async () => response(approval)),
      /does not match/,
    );
  }
  await assert.rejects(
    requireScreenApproval("project", request, async () => ({
      isError: true,
      content: [{ type: "text", text: "Confirm inventory first" }],
    })),
    /Confirm inventory/,
  );
});
