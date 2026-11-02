/**
 * Uploads a verification report's evidence PNGs to the Proto website.
 *
 * The server stores evidence under a key named by the file's sha256
 * (`screen-indexes/<index>/<checksum>.png`), so identical files are the
 * same object: each distinct file is signed and PUT once, and every
 * scenario that names it gets the same key back. Signing and PUTs run a
 * bounded number at a time and retry transient failures. Files a previous
 * run already uploaded for this index (recorded locally after a PUT
 * succeeded) are not uploaded again; `uploadEvidence` reports which were
 * skipped so the caller can upload them after all if the server says one
 * is missing.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** A failure worth trying again: the network, a timeout, rate limiting or
 *  a server error. A refused credential or a 4xx from storage is not. */
export function isTransient(error) {
  if (error?.permanent) return false;
  if (typeof error?.status === "number")
    return error.status === 408 || error.status === 429 || error.status >= 500;
  return !/no longer works|not set up|not linked/i.test(String(error?.message ?? ""));
}

/** Run `task` until it succeeds, up to `attempts` times, backing off
 *  between transient failures. */
export async function withRetry(task, { attempts = 4, backoff = 400, sleep = wait } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= attempts || !isTransient(error)) throw error;
      await sleep(backoff * 2 ** (attempt - 1) * (0.5 + Math.random()));
    }
  }
}

/** Map `items` through `fn`, at most `limit` at a time, in order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** PUT bytes to a signed storage URL; a failure carries its HTTP status. */
export async function putArtifact(url, bytes) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  if (!response.ok) {
    const error = new Error(`Artifact upload failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
}

/** Checksum → key of evidence this laptop has uploaded to one index on
 *  one Proto site, kept in `path`. Unreadable means empty. */
export function evidenceRecord(path, app, indexId) {
  let all = {};
  try {
    all = JSON.parse(readFileSync(path, "utf8"));
  } catch {}
  const known = { ...(all?.[app]?.[indexId] ?? {}) };
  return {
    known,
    save(uploaded, forgotten = []) {
      let latest = {};
      try {
        latest = JSON.parse(readFileSync(path, "utf8"));
      } catch {}
      const entry = { ...(latest?.[app]?.[indexId] ?? {}), ...uploaded };
      for (const checksum of forgotten) delete entry[checksum];
      latest[app] = { ...(latest[app] ?? {}), [indexId]: entry };
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(latest));
      renameSync(temporary, path);
    },
  };
}

/**
 * Replace each scenario's evidence paths with storage keys, in place and
 * in the same order.
 *
 * sign(checksum, size) → { key, uploadUrl } asks the server for one upload;
 * put(url, bytes) stores it. `known` maps checksums already uploaded to
 * their keys; those are neither signed nor PUT. Returns what happened:
 * files named, distinct files, uploaded, skipped as known, and the
 * checksum → key of what was uploaded now.
 */
export async function uploadEvidence(
  scenarios,
  { sign, put = putArtifact, known = {}, concurrency = 16, attempts = 4, backoff = 400, sleep, read = readFileSync },
) {
  const byPath = new Map();
  const files = new Map();
  for (const scenario of scenarios)
    for (const path of scenario.evidence) {
      if (byPath.has(path)) continue;
      const bytes = read(path);
      const checksum = sha256(bytes);
      byPath.set(path, checksum);
      if (!files.has(checksum)) files.set(checksum, bytes);
    }
  const keys = new Map();
  const pending = [];
  const skipped = [];
  for (const [checksum, bytes] of files) {
    if (known[checksum]) {
      keys.set(checksum, known[checksum]);
      skipped.push(checksum);
    } else pending.push([checksum, bytes]);
  }
  const uploaded = {};
  await mapLimit(pending, concurrency, async ([checksum, bytes]) => {
    // Sign afresh on every attempt: a signed URL is good for ten minutes.
    const key = await withRetry(
      async () => {
        const capture = await sign(checksum, bytes.length);
        await put(capture.uploadUrl, bytes);
        return capture.key;
      },
      { attempts, backoff, sleep },
    );
    keys.set(checksum, key);
    uploaded[checksum] = key;
  });
  for (const scenario of scenarios)
    scenario.evidence = scenario.evidence.map((path) => keys.get(byPath.get(path)));
  return {
    named: scenarios.reduce((n, s) => n + s.evidence.length, 0),
    distinct: files.size,
    uploaded,
    skipped,
  };
}
