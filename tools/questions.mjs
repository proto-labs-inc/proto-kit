#!/usr/bin/env node
/**
 * A build's questions, answerable on the Proto site. The agent asks
 * (build-stream.mjs question), the site shows the question in the build
 * with its options, suggested replies and a reply box, and the person's
 * answer comes back to this laptop as a courier command:
 *
 *   { "run": "answer", "briefId", "questionId", "option" | "text" | "hold": true }
 *
 * The build waits for it (build-stream.mjs await-answer): it follows
 * the codebase's courier feed and takes the answer to its own question.
 * A hold (the person started answering) stops the default countdown.
 * With no answer and no hold, the laptop goes with the recommended
 * option once `defaultAfterSeconds` have passed since the question was
 * asked, and says so to the site (`answered` by "default"). An answer
 * given on the site is already in the build's stream (the site appends
 * it before it delivers the command), so the laptop never repeats it.
 *
 * The feed is the listen skill's (skills/listen/SKILL.md), and its
 * offset.json commits lines in order only, while an answer arrives
 * behind the brief whose build asked it, which is still in hand. So a
 * line taken out of turn is recorded in courier/taken.jsonl; offset.json
 * moves over taken lines only where they follow it directly, and every
 * other line stays in the feed for the listen skill. A question being
 * waited on has a marker in courier/awaiting/, so the listen skill can
 * tell an answer some build will take from a stray one:
 *
 *   node tools/questions.mjs route <codebase> <offset>
 *       one line about the answer command ending at <offset>: taken by
 *       its build, about to be, or stray (no build waiting: dropped)
 *
 * Everything else here is a library for build-stream.mjs and
 * proto-build.mjs.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---- the shapes, as the site's schema has them (web/src/lib/build-events.ts) ----

const ID = /^[a-z0-9][a-z0-9-]*$/;
export const QUESTION_FORMS = ["copy-gate", "generic"];

/** How long a copy-gate question waits before the laptop goes with the recommended option. */
export const COPY_GATE_DEFAULT_SECONDS = 30;

/** A question id: short, unique within its build. */
export function newQuestionId() {
  return `q-${randomBytes(4).toString("hex")}`;
}

const isId = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 40 && ID.test(value.trim());
const text = (value, max) => (typeof value === "string" && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null);

/**
 * The question event the site stores, from the agent's fields, or an
 * Error naming everything the site would refuse. `form` is copy-gate or
 * generic; options are 2 or 3 { id, label }.
 */
export function questionEvent(fields) {
  const problems = [];
  const event = { kind: "question", id: fields.id, form: fields.form };
  if (!isId(fields.id)) problems.push("the question id must be lowercase letters, digits and dashes, at most 40");
  if (!QUESTION_FORMS.includes(fields.form)) problems.push(`--kind must be one of ${QUESTION_FORMS.join(", ")}`);
  event.text = text(fields.text, 200);
  if (!event.text) problems.push("the question must be 1 to 200 characters");
  for (const key of ["detail", "impact"]) {
    if (fields[key] === undefined) continue;
    event[key] = text(fields[key], 500);
    if (!event[key]) problems.push(`--${key} must be 1 to 500 characters`);
  }
  const options = fields.options ?? [];
  event.options = options.map((option) => ({ id: option.id?.trim(), label: text(option.label, 40) }));
  if (options.length < 2 || options.length > 3) problems.push("a question has 2 or 3 options");
  for (const option of event.options) {
    if (!isId(option.id)) problems.push(`option id "${option.id}" must be lowercase letters, digits and dashes`);
    if (!option.label) problems.push(`option ${option.id} needs a label of 1 to 40 characters`);
  }
  const ids = event.options.map((option) => option.id);
  if (new Set(ids).size !== ids.length) problems.push("option ids must differ");
  if (fields.recommended !== undefined) {
    event.recommended = fields.recommended;
    if (!ids.includes(fields.recommended)) problems.push("--recommended must be one of the options");
  }
  if (fields.defaultAfterSeconds !== undefined) {
    event.defaultAfterSeconds = fields.defaultAfterSeconds;
    if (!Number.isInteger(fields.defaultAfterSeconds) || fields.defaultAfterSeconds < 5 || fields.defaultAfterSeconds > 600) problems.push("--default-after must be whole seconds, 5 to 600");
    if (fields.recommended === undefined) problems.push("a default needs --recommended");
  }
  if (fields.suggestions !== undefined && fields.suggestions.length > 0) {
    event.suggestions = fields.suggestions.map((suggestion) => text(suggestion, 80));
    if (event.suggestions.length > 3) problems.push("at most 3 suggestions");
    if (event.suggestions.some((suggestion) => !suggestion)) problems.push("each suggestion is 1 to 80 characters");
  }
  if (fields.copied !== undefined) {
    event.copied = fields.copied;
    if (!Number.isFinite(fields.copied) || fields.copied < 0 || fields.copied > 100) problems.push("--copied is 0 to 100");
  }
  if (fields.missing !== undefined) {
    event.missing = fields.missing;
    if (fields.missing.length > 40) problems.push("--missing names at most 40 parts");
    if (fields.missing.some((id) => !text(id, 80))) problems.push("each --missing node id is 1 to 80 characters");
  }
  if (fields.form === "copy-gate" && (fields.copied === undefined || fields.missing === undefined)) problems.push("a copy-gate question carries --copied and --missing");
  if (problems.length > 0) return new Error(problems.join("; "));
  return event;
}

/**
 * An answer command as the courier accepts it, normalized, or null: the
 * brief and question it answers and exactly one of an option, a reply
 * or a hold.
 */
export function answerCommand(command) {
  if (!command || command.run !== "answer") return null;
  if (typeof command.briefId !== "string" || command.briefId.length === 0 || !isId(command.questionId)) return null;
  const out = { run: "answer", briefId: command.briefId, questionId: command.questionId.trim() };
  const given = ["option", "text", "hold"].filter((key) => command[key] !== undefined);
  if (given.length !== 1) return null;
  if (given[0] === "option") {
    if (!isId(command.option)) return null;
    out.option = command.option.trim();
  } else if (given[0] === "text") {
    const reply = text(command.text, 500);
    if (!reply) return null;
    out.text = reply;
  } else {
    if (command.hold !== true) return null;
    out.hold = true;
  }
  return out;
}

// ---- the courier feed ----

export const courierDir = (codebase) => join(process.env.HOME ?? "", ".proto", codebase, "run", "courier");
const offsetPath = (codebase) => join(courierDir(codebase), "offset.json");
const takenPath = (codebase) => join(courierDir(codebase), "taken.jsonl");
const awaitingDir = (codebase) => join(courierDir(codebase), "awaiting");
const awaitingPath = (codebase, questionId) => join(awaitingDir(codebase), `${questionId}.json`);

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function committedOffset(codebase) {
  const value = readJson(offsetPath(codebase), {}).offset;
  return Number.isFinite(value) ? value : 0;
}

/** The feed's complete lines from byte `from`: [{ start, offset, command }], offset being the byte after the line. */
export function feedLines(codebase, from = 0) {
  const feed = join(courierDir(codebase), "commands.jsonl");
  let size;
  try {
    size = statSync(feed).size;
  } catch {
    return [];
  }
  const start = size < from ? 0 : from;
  if (size === start) return [];
  const fd = openSync(feed, "r");
  const buffer = Buffer.alloc(size - start);
  readSync(fd, buffer, 0, buffer.length, start);
  closeSync(fd);
  const whole = buffer.toString("utf8");
  const lines = [];
  let at = start;
  for (const line of whole.slice(0, whole.lastIndexOf("\n") + 1).split("\n").slice(0, -1)) {
    const begins = at;
    at += Buffer.byteLength(line, "utf8") + 1;
    if (line.trim().length === 0) continue;
    let command = null;
    try {
      command = JSON.parse(line);
    } catch {
      // A line nobody can read is the listen skill's to report, not ours.
    }
    lines.push({ start: begins, offset: at, command });
  }
  return lines;
}

/** The feed lines taken out of turn: offset -> { questionId, by }. */
export function takenLines(codebase) {
  const taken = new Map();
  if (!existsSync(takenPath(codebase))) return taken;
  for (const line of readFileSync(takenPath(codebase), "utf8").split("\n").filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      taken.set(entry.offset, entry);
    } catch {}
  }
  return taken;
}

function take(codebase, entry) {
  mkdirSync(courierDir(codebase), { recursive: true });
  appendFileSync(takenPath(codebase), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/**
 * Moves offset.json over taken lines that follow it directly, so a
 * taken answer does not replay to the listen skill once nothing before
 * it is waiting. Never over a line that was not taken.
 */
export function commitTaken(codebase) {
  const taken = takenLines(codebase);
  const from = committedOffset(codebase);
  let offset = from;
  for (const line of feedLines(codebase, from)) {
    if (line.start !== offset || !taken.has(line.offset)) break;
    offset = line.offset;
  }
  if (offset !== from) writeFileSync(offsetPath(codebase), JSON.stringify({ offset }));
  return offset;
}

// ---- questions being waited on ----

/** Recorded when the question is asked, so an answer that arrives before the wait starts still has a home. */
export function markAsked(codebase, { briefId, questionId, recommended, defaultAfterSeconds }, askedAt = Date.now()) {
  mkdirSync(awaitingDir(codebase), { recursive: true });
  writeFileSync(awaitingPath(codebase, questionId), JSON.stringify({ briefId, questionId, recommended: recommended ?? null, defaultAfterSeconds: defaultAfterSeconds ?? null, askedAt, pid: null }) + "\n");
}

export function askedQuestion(codebase, questionId) {
  return readJson(awaitingPath(codebase, questionId), null);
}

function clearAsked(codebase, questionId) {
  rmSync(awaitingPath(codebase, questionId), { force: true });
}

// A question nobody is waiting on any more (its build died) stops
// claiming answers after this long.
const ASKED_STALE_MS = 60 * 60_000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Whether some build is (or is about to be) waiting on this question. */
export function isAwaited(codebase, questionId, now = Date.now()) {
  const asked = askedQuestion(codebase, questionId);
  if (!asked) return false;
  return alive(asked.pid) || now - asked.askedAt < ASKED_STALE_MS;
}

/**
 * Waits for the answer to one question and returns it:
 *   { by: "option", option } | { by: "reply", text } | { by: "default", option }
 * `sendDefault(option)` tells the site the laptop went with the
 * recommended option and resolves "sent", or "already-answered" when
 * the site says someone answered first; then that answer's command is
 * on its way (the site keeps an answer only once the courier took it),
 * and the wait goes on for it.
 */
export async function awaitAnswer({ codebase, briefId, questionId, sendDefault, log = () => {}, pollMs = 250, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const asked = askedQuestion(codebase, questionId) ?? { briefId, questionId, recommended: null, defaultAfterSeconds: null, askedAt: now() };
  writeFileSync(awaitingPath(codebase, questionId), JSON.stringify({ ...asked, pid: process.pid }) + "\n");
  const deadline = asked.recommended && asked.defaultAfterSeconds ? asked.askedAt + asked.defaultAfterSeconds * 1000 : null;
  /** Where the default stands: counting down, stopped by a hold, or refused because the site had an answer. */
  let countdown = deadline === null ? "none" : "running";
  try {
    for (;;) {
      const taken = takenLines(codebase);
      for (const line of feedLines(codebase, committedOffset(codebase))) {
        if (taken.has(line.offset)) continue;
        const answer = answerCommand(line.command);
        if (!answer || answer.briefId !== briefId || answer.questionId !== questionId) continue;
        if (answer.hold) {
          take(codebase, { offset: line.offset, questionId, by: "hold" });
          if (countdown === "running") log("Someone started answering on the site: the countdown is held.");
          countdown = "held";
          continue;
        }
        take(codebase, { offset: line.offset, questionId, by: "build" });
        commitTaken(codebase);
        if (answer.option !== undefined) return { by: "option", option: answer.option };
        return { by: "reply", text: answer.text };
      }
      if (countdown === "running" && now() >= deadline) {
        const outcome = await sendDefault(asked.recommended);
        if (outcome === "sent") return { by: "default", option: asked.recommended };
        log("The site already has an answer to this question: waiting for it to arrive.");
        countdown = "refused";
      }
      await sleep(pollMs);
    }
  } finally {
    clearAsked(codebase, questionId);
  }
}

/** Once the question is answered some other way (in the terminal), nobody waits on it. */
export function settleAsked(codebase, questionId) {
  clearAsked(codebase, questionId);
}

/**
 * What the listen skill does with the answer command ending at
 * `offset`: one line for the conversation, and whether it was dropped.
 */
export function routeAnswer(codebase, offset) {
  const line = feedLines(codebase, 0).find((candidate) => candidate.offset === offset);
  if (!line) return { route: "missing", line: `No feed line ends at ${offset}.` };
  const answer = answerCommand(line.command);
  if (!answer) return { route: "not-an-answer", line: "That line is not an answer to a question." };
  const taken = takenLines(codebase).get(offset);
  if (taken?.by === "dropped") return { route: "dropped", line: `The answer to question ${answer.questionId} was already dropped.` };
  if (taken) return { route: "taken", line: `The build that asked question ${answer.questionId} took its answer.` };
  if (isAwaited(codebase, answer.questionId)) return { route: "awaited", line: `The build that asked question ${answer.questionId} takes its answer.` };
  take(codebase, { offset, questionId: answer.questionId, by: "dropped" });
  commitTaken(codebase);
  return { route: "dropped", line: `An answer to question ${answer.questionId} of build ${answer.briefId} came in, but no build is waiting on it: dropped.` };
}

// ---- command line ----

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command, codebase, offsetArg] = process.argv.slice(2);
  const offset = Number(offsetArg);
  if (command !== "route" || !codebase || !Number.isInteger(offset)) {
    console.error("usage: node tools/questions.mjs route <codebase> <offset>");
    process.exit(1);
  }
  const routed = routeAnswer(codebase, offset);
  console.log(routed.line);
  process.exit(["missing", "not-an-answer"].includes(routed.route) ? 1 : 0);
}

