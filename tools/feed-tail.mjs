#!/usr/bin/env node
/**
 * Follows the courier's command feed for the product agent's Monitor
 * watch. Prints every complete line of <run-dir>/commands.jsonl from
 * the committed offset onward — replaying anything that arrived while
 * no watch was armed — then keeps following the file. Runs until
 * killed (the Monitor kills it when the watch ends; the agent re-arms).
 *
 * Each output line is an envelope: {"offset": <byte end of this line>,
 * "command": {…}}. The CONSUMER commits progress by writing
 * {"offset": N} to <run-dir>/offset.json after acting on a line —
 * this tool never writes, so delivery is at-least-once across watch
 * gaps, agent restarts, and reboots (see docs/claude-code-mechanics.md,
 * "Lines emitted while no watch is armed are LOST to the watch").
 *
 * Usage: node feed-tail.mjs <run-dir>
 */
import { openSync, readSync, readFileSync, statSync, closeSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node feed-tail.mjs <run-dir>");
  process.exit(1);
}
const feed = join(runDir, "commands.jsonl");

let offset = 0;
try {
  offset = JSON.parse(readFileSync(join(runDir, "offset.json"), "utf8")).offset ?? 0;
} catch {}

let carry = "";
function drain() {
  let size;
  try {
    size = statSync(feed).size;
  } catch {
    return; // feed not created yet
  }
  if (size < offset) offset = 0; // feed was rotated/truncated: replay
  if (size === offset) return;
  const fd = openSync(feed, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  carry += buf.toString("utf8");
  let consumed = offset;
  let nl;
  while ((nl = carry.indexOf("\n")) !== -1) {
    const line = carry.slice(0, nl);
    carry = carry.slice(nl + 1);
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length === 0) continue;
    try {
      console.log(JSON.stringify({ offset: consumed, command: JSON.parse(line) }));
    } catch {
      console.log(JSON.stringify({ offset: consumed, malformed: line }));
    }
  }
  offset = consumed;
}

// Heartbeat: the courier's status reports agentListening from this
// file's freshness — a live watch means a live consumer.
let lastBeat = 0;
function beat() {
  if (Date.now() - lastBeat < 5000) return;
  lastBeat = Date.now();
  try {
    writeFileSync(join(runDir, "watch-heartbeat.json"), JSON.stringify({ at: new Date().toISOString() }));
  } catch {}
}

drain();
beat();
setInterval(() => {
  drain();
  beat();
}, 500);
