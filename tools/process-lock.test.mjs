import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLock, withProcessLock } from "./process-lock.mjs";

test("a living resource owner is not evicted and queued work runs only after release", async () => {
  const root = mkdtempSync(join(tmpdir(), "proto-lock-"));
  try {
    const path = join(root, "source.lock");
    const release = await acquireProcessLock(path);
    await assert.rejects(acquireProcessLock(path, { timeoutMs: 60 }), /Timed out/);
    let ran = false;
    const waiting = withProcessLock(path, async () => { ran = true; });
    assert.equal(ran, false);
    await release();
    await waiting;
    assert.equal(ran, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a killed process releases its resource without deleting a successor's lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "proto-lock-crash-"));
  const path = join(root, "source.lock");
  const module = new URL("./process-lock.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import { acquireProcessLock } from ${JSON.stringify(module)}; await acquireProcessLock(process.argv[1]); console.log('ready');`, path]);
  try {
    await once(child.stdout, "data");
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    let inside = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 4 }, () => withProcessLock(path, async () => {
      inside += 1; peak = Math.max(peak, inside);
      await new Promise(resolve => setTimeout(resolve, 20));
      inside -= 1;
    })));
    assert.equal(peak, 1);
  } finally { child.kill(); rmSync(root, { recursive: true, force: true }); }
});
