#!/usr/bin/env node
/**
 * Follows every codebase's courier feed at once — the plugin-monitor
 * flavor of feed-tail.mjs, for an interactive session running the listen skill
 * (plugin monitors don't run in headless -p sessions; there the skill
 * arms the Monitor tool on feed-tail.mjs itself).
 *
 * Emits one line per command, envelope {"codebase", "offset",
 * "command"}; the consumer commits {"offset": N} to that codebase's
 * run/courier/offset.json after acting, same at-least-once contract
 * as feed-tail. Picks up codebases created while running. Runs until
 * killed.
 */
import { openSync, readSync, readFileSync, statSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeWatchStamp } from "./watch-stamp.mjs";

const root = join(process.env.HOME ?? "", ".proto");
const feeds = new Map(); // codebase -> {offset, carry}

function drainCodebase(codebase) {
  const runDir = join(root, codebase, "run", "courier");
  const feed = join(runDir, "commands.jsonl");
  let state = feeds.get(codebase);
  if (!state) {
    let offset = 0;
    try {
      offset = JSON.parse(readFileSync(join(runDir, "offset.json"), "utf8")).offset ?? 0;
    } catch {}
    state = { offset, carry: "" };
    feeds.set(codebase, state);
  }
  let size;
  try {
    size = statSync(feed).size;
  } catch {
    return;
  }
  if (size < state.offset) state.offset = 0;
  if (size === state.offset) return;
  const fd = openSync(feed, "r");
  const buf = Buffer.alloc(size - state.offset);
  readSync(fd, buf, 0, buf.length, state.offset);
  closeSync(fd);
  state.carry += buf.toString("utf8");
  let consumed = state.offset;
  let nl;
  while ((nl = state.carry.indexOf("\n")) !== -1) {
    const line = state.carry.slice(0, nl);
    state.carry = state.carry.slice(nl + 1);
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length === 0) continue;
    try {
      console.log(JSON.stringify({ codebase, offset: consumed, command: JSON.parse(line) }));
    } catch {
      console.log(JSON.stringify({ codebase, offset: consumed, malformed: line }));
    }
  }
  state.offset = consumed;
}

// Heartbeat per codebase: the courier reports agentListening from the
// stamp's freshness (a live watch means a live consumer). This watcher
// is Claude Code's plugin monitor and nothing else's, so the stamp
// names that harness.
let lastBeat = 0;
function beat(codebases) {
  if (Date.now() - lastBeat < 5000) return;
  lastBeat = Date.now();
  for (const p of codebases) {
    try {
      statSync(join(root, p, "run", "courier"));
      writeWatchStamp(join(root, p, "run", "courier"), "claude");
    } catch {}
  }
}

function tick() {
  let codebases = [];
  try {
    codebases = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "chrome")
      .map((e) => e.name);
  } catch {
    return; // no ~/.proto yet; keep waiting
  }
  for (const p of codebases) drainCodebase(p);
  beat(codebases);
}

tick();
setInterval(tick, 500);
