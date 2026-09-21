#!/usr/bin/env node
/**
 * Follows every product's courier feed at once — the plugin-monitor
 * flavor of feed-tail.mjs, for an INTERACTIVE product-agent session
 * (plugin monitors don't run in headless -p sessions; there the skill
 * arms the Monitor tool on feed-tail.mjs itself).
 *
 * Emits one line per command, envelope {"product", "offset",
 * "command"}; the consumer commits {"offset": N} to that product's
 * run/courier/offset.json after acting, same at-least-once contract
 * as feed-tail. Picks up products created while running. Runs until
 * killed.
 */
import { openSync, readSync, readFileSync, statSync, closeSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(process.env.HOME ?? "", ".proto");
const feeds = new Map(); // product -> {offset, carry}

function drainProduct(product) {
  const runDir = join(root, product, "run", "courier");
  const feed = join(runDir, "commands.jsonl");
  let state = feeds.get(product);
  if (!state) {
    let offset = 0;
    try {
      offset = JSON.parse(readFileSync(join(runDir, "offset.json"), "utf8")).offset ?? 0;
    } catch {}
    state = { offset, carry: "" };
    feeds.set(product, state);
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
      console.log(JSON.stringify({ product, offset: consumed, command: JSON.parse(line) }));
    } catch {
      console.log(JSON.stringify({ product, offset: consumed, malformed: line }));
    }
  }
  state.offset = consumed;
}

// Heartbeat per product: the courier's status reports agentListening
// from this file's freshness — a live watch means a live consumer.
let lastBeat = 0;
function beat(products) {
  if (Date.now() - lastBeat < 5000) return;
  lastBeat = Date.now();
  const stamp = JSON.stringify({ at: new Date().toISOString() });
  for (const p of products) {
    try {
      statSync(join(root, p, "run", "courier"));
      writeFileSync(join(root, p, "run", "courier", "watch-heartbeat.json"), stamp);
    } catch {}
  }
}

function tick() {
  let products = [];
  try {
    products = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "chrome")
      .map((e) => e.name);
  } catch {
    return; // no ~/.proto yet; keep waiting
  }
  for (const p of products) drainProduct(p);
  beat(products);
}

tick();
setInterval(tick, 500);
