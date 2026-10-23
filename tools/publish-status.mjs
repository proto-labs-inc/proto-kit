/**
 * The latest prototype publication attempt, private to its workspace. Both
 * explicit and turn-end publishing write this record, including failures
 * before an upload starts. Readers may treat a publishing record whose pid
 * is gone as interrupted. It is never included in public/ or dist/.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { takeRunLock } from "./run-lock.mjs";

export const publishStatusPath = (workspace) => join(workspace, ".proto", "publish-status.json");

export function readPublishStatus(workspace) {
  try {
    const status = JSON.parse(readFileSync(publishStatusPath(workspace), "utf8"));
    return status?.version === 1 && typeof status.attemptId === "string" ? status : null;
  } catch {
    return null;
  }
}

/** Keep diagnostics useful without terminal controls or credential-bearing URLs. */
export function publishError(error) {
  return stripVTControlCharacters(String(error?.message ?? error ?? "Publishing failed"))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
    .replace(/https?:\/\/[^\s<>"']+/g, (text) => {
      try {
        const url = new URL(text);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch { return "[URL]"; }
    })
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .trim().slice(0, 2_000) || "Publishing failed";
}

/** A short lock makes the ownership check and atomic replacement one operation. */
function update(workspace, change) {
  const directory = join(workspace, ".proto");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "publish-status.lock");
  takeRunLock(lock, { wait: true, waitMs: 5_000 });
  const temporary = join(directory, `publish-status.${randomUUID()}.tmp`);
  try {
    const next = change(readPublishStatus(workspace));
    if (!next) return null;
    writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, publishStatusPath(workspace));
    return next;
  } finally {
    rmSync(temporary, { force: true });
    rmSync(lock, { recursive: true, force: true });
  }
}

/** The automatic publisher passes its attempt to its upload child. The parent
 * stays alive through building and upload, so its pid owns that entire attempt. */
export function startPublishAttempt(workspace, attemptId = null) {
  return update(workspace, (current) => {
    if (attemptId) {
      if (current?.attemptId !== attemptId || current.status !== "publishing") {
        throw new Error("This publishing attempt was replaced; run publishing again");
      }
      return current;
    }
    return { version: 1, attemptId: randomUUID(), status: "publishing", startedAt: new Date().toISOString(), pid: process.pid };
  });
}

/** A late process cannot change a newer attempt, or undo a completed publish. */
export function failPublishAttempt(workspace, attemptId, error) {
  return update(workspace, (current) => {
    if (current?.attemptId !== attemptId || current.status !== "publishing") return null;
    return { ...current, status: "failed", finishedAt: new Date().toISOString(), error: publishError(error) };
  });
}

export function completePublishAttempt(workspace, attemptId, publishedUrl) {
  return update(workspace, (current) => {
    if (current?.attemptId !== attemptId || current.status !== "publishing") return null;
    return { ...current, status: "published", finishedAt: new Date().toISOString(), publishedUrl };
  });
}
