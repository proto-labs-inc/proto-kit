#!/usr/bin/env node
/**
 * The Codex wake: delivers the courier's commands into the session the
 * person is actually looking at.
 *
 * On Claude Code the Monitor tool wakes the listening session per feed
 * line. On Codex nothing wakes an idle session, so without this the
 * command just sits in commands.jsonl. This daemon watches the feed
 * and, per line, queues the command into the recorded live thread
 * (`codex queue --thread <id> --message …`), so the work happens in
 * the user's own open window, in front of them, with their context —
 * unlike feed-drive.mjs, which runs commands headlessly in a resumed
 * conversation nobody is watching.
 *
 * Offsets keep feed-tail's at-least-once contract: the offset is
 * committed only after the queue call succeeds, so a crash mid-deliver
 * re-delivers rather than drops.
 *
 * The thread id comes from courier.json's codexThread block, written
 * by `codex-thread.mjs identify` when the listen skill starts. A
 * thread with no writer lock means the person closed that session:
 * say so once, plainly, and leave the command in the feed for when
 * they come back. (Lock, not the queue call's exit status: queueing
 * into a closed thread still exits 0 and the message is never read.)
 *
 * Usage: node feed-queue.mjs <run-dir>   (reads <run-dir>/courier.json)
 *
 * Optional courier.json override:
 *   "codexQueue": { "instruction": "… {command} …" }
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { managedCodex, threadIsLive } from "./codex-thread.mjs";
import { writeWatchStamp } from "./watch-stamp.mjs";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node feed-queue.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
const feed = join(runDir, "commands.jsonl");
const offsetPath = join(runDir, "offset.json");

const DEFAULT_INSTRUCTION =
  "Proto courier command. Act on it now, here in this session, following the proto listen skill " +
  "(skills/listen/SKILL.md) — report progress for a brief, and treat this as the next thing you do. " +
  "The courier owns the feed offset for this session, so do not arm a feed watch and do not write " +
  "offset.json. Command: {command}";

const instruction = (line) => (config.codexQueue?.instruction ?? DEFAULT_INSTRUCTION).replaceAll("{command}", line);

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
};

// Everything past the committed offset, whole lines only (a partial
// trailing line waits for the next pass). Same shape as feed-drive.
function pending() {
  let offset = readJson(offsetPath, { offset: 0 }).offset ?? 0;
  let size;
  try {
    size = statSync(feed).size;
  } catch {
    return [];
  }
  if (size < offset) offset = 0;
  if (size === offset) return [];
  const fd = openSync(feed, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  const text = buf.toString("utf8");
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const out = [];
  let consumed = offset;
  for (const line of complete.split("\n").slice(0, -1)) {
    consumed += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length > 0) out.push({ offset: consumed, line });
  }
  return out;
}

// Say a given condition once, not once per tick: this loop runs every
// few seconds and the person may be away from the laptop for hours.
let said = null;
function sayOnce(key, message) {
  if (said === key) return;
  said = key;
  console.log(message);
}

function deliver({ offset, line }, bin, threadId) {
  console.log(`queue: -> ${threadId} <- ${line.slice(0, 80)}`);
  try {
    execFileSync(bin, ["queue", "--thread", threadId, "--message", instruction(line)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    sayOnce("refused", `Codex wouldn't take the command for your open session: ${String(err.stderr ?? err.message).trim()}`);
    return false;
  }
  writeFileSync(offsetPath, JSON.stringify({ offset }));
  console.log(`queue: delivered, offset ${offset}`);
  return true;
}

// The courier reports agentListening from this stamp's freshness. On
// Codex the live thread IS the listening session, so stamp it while
// the thread holds its lock — otherwise the site would tell the user
// their agent isn't running while it plainly is. The stamp names Codex,
// so the site names it too.
function beat() {
  try {
    writeWatchStamp(runDir, "codex");
  } catch {}
}

function tick() {
  const thread = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8")).codexThread;
  if (!thread?.id) {
    sayOnce("unrecorded", "No Codex session has said it's listening for this codebase yet, so commands are waiting in the feed.");
    return;
  }
  if (!threadIsLive(thread.id)) {
    sayOnce("closed", `The Codex session that was listening (recorded ${thread.recordedAt}) is closed, so commands are waiting in the feed until one is open again.`);
    return;
  }
  beat();
  let bin;
  try {
    ({ bin } = managedCodex());
  } catch (err) {
    sayOnce("daemon", err.message);
    return;
  }
  said = null; // healthy again: a later break is worth saying afresh
  for (const item of pending()) {
    if (!deliver(item, bin, thread.id)) break; // retry the same command next tick
  }
}

tick();
setInterval(tick, 3000);
