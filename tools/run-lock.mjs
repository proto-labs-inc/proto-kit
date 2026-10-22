/**
 * A prototype run's publish lock, <run>/publish.lock: held by
 * tools/auto-publish.mjs while it builds and uploads at a turn's end, and
 * by tools/publish.mjs for the publish a skill runs, so the two never
 * build into one dist/ or upload at once. mkdir is atomic: whoever makes
 * the folder holds the lock, and writes its pid into it. A lock whose
 * holder is gone (the app quit mid publish) is free at once; otherwise the
 * holder refreshes its time as it goes, and only a lock left untouched for
 * STALE_MS is taken over.
 */
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function holderGone(lock) {
  let pid;
  try {
    pid = Number(readFileSync(join(lock, "pid"), "utf8"));
  } catch {
    return false; // being written, or an older lock: fall back to its age
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

const STALE_MS = 20 * 60_000;
const WAIT_MS = 10 * 60_000;

/** Take the lock. Without `wait`, false when someone else holds it; with
 *  it, waits up to `waitMs` and throws when the lock never comes free. */
export function takeRunLock(lock, { wait, waitMs = WAIT_MS, staleMs = STALE_MS } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    if (holderGone(lock)) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {
      continue; // released between the two calls
    }
    if (age > staleMs) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (!wait) return false;
    if (Date.now() > deadline) throw new Error(`${lock} is held by another publish; remove it if nothing is running`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

/** Mark the lock as still in use. */
export function refreshRunLock(lock) {
  try {
    const now = new Date();
    utimesSync(lock, now, now);
  } catch {}
}
