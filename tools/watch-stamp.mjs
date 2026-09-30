/**
 * The watch stamp: how a courier knows a session is listening, and in
 * which harness. Every feed watcher (feed-tail.mjs, feed-watch-all.mjs,
 * the Codex wake in feed-queue.mjs) writes <run-dir>/watch-heartbeat.json
 * every few seconds through writeWatchStamp; courier.mjs reads it through
 * readWatchStamp and reports both facts to the relay, which the site
 * shows as "Listening" and the agent's name on the path.
 *
 * The harness is one of HARNESSES, the relay protocol's word set
 * (packages/relay/src/protocol.ts in the proto repo); change both
 * together. A watcher that names none stamps null, and the site then
 * says "your harness".
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const HARNESSES = ["claude", "codex", "cursor"];

/** How old the stamp may be before the watcher counts as gone. The
 *  watchers stamp every five seconds. */
export const WATCH_STALE_MS = 15_000;

/** The harness named by `--harness <name>` in an argument list, or null;
 *  a name outside HARNESSES is an error, because a typo here would
 *  silently show the wrong agent on the site. */
export function harnessFromArgs(args) {
  const at = args.indexOf("--harness");
  if (at === -1) return null;
  const name = args[at + 1];
  if (!HARNESSES.includes(name)) {
    throw new Error(`--harness must be one of ${HARNESSES.join(", ")}, not ${JSON.stringify(name ?? "")}`);
  }
  return name;
}

export function writeWatchStamp(runDir, harness) {
  writeFileSync(join(runDir, "watch-heartbeat.json"), JSON.stringify({ at: new Date().toISOString(), harness }));
}

/** What the stamp says right now: whether anyone is consuming commands,
 *  which harness they run in (null when the stamp names none, or is
 *  stale), and when it was last written. */
export function readWatchStamp(runDir, now = Date.now()) {
  try {
    const beat = JSON.parse(readFileSync(join(runDir, "watch-heartbeat.json"), "utf8"));
    const agentListening = now - Date.parse(beat.at) < WATCH_STALE_MS;
    const harness = agentListening && HARNESSES.includes(beat.harness) ? beat.harness : null;
    return { agentListening, harness, lastSeenAt: beat.at };
  } catch {
    return { agentListening: false, harness: null, lastSeenAt: null };
  }
}
