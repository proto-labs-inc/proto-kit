import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessFromArgs, readWatchStamp, WATCH_STALE_MS, writeWatchStamp } from "./watch-stamp.mjs";

const runDir = () => mkdtempSync(join(tmpdir(), "watch-stamp-"));

test("a fresh stamp says a session listens, and in which harness", () => {
  const dir = runDir();
  writeWatchStamp(dir, "codex");
  assert.deepEqual(readWatchStamp(dir, Date.now() + 1000), { agentListening: true, harness: "codex", lastSeenAt: readWatchStamp(dir).lastSeenAt });
});

test("a stale stamp says nothing listens, and names no harness", () => {
  const dir = runDir();
  writeWatchStamp(dir, "claude");
  const read = readWatchStamp(dir, Date.now() + WATCH_STALE_MS + 1);
  assert.equal(read.agentListening, false);
  assert.equal(read.harness, null);
});

test("a stamp from before harnesses were named still says listening, with no harness", () => {
  const dir = runDir();
  writeFileSync(join(dir, "watch-heartbeat.json"), JSON.stringify({ at: new Date().toISOString() }));
  assert.deepEqual(readWatchStamp(dir).agentListening, true);
  assert.equal(readWatchStamp(dir).harness, null);
});

test("no stamp is nobody listening", () => {
  assert.deepEqual(readWatchStamp(runDir()), { agentListening: false, harness: null, lastSeenAt: null });
});

test("--harness names one of the three, or is refused", () => {
  assert.equal(harnessFromArgs(["--once"]), null);
  assert.equal(harnessFromArgs(["--harness", "cursor", "--once"]), "cursor");
  assert.throws(() => harnessFromArgs(["--harness", "claude-code"]), /--harness must be one of/);
  assert.throws(() => harnessFromArgs(["--harness"]), /--harness must be one of/);
});
