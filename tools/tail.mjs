#!/usr/bin/env node
/**
 * When work is the long tail, decided by numbers the tools compute,
 * never by an agent's feel for it. The skills obey what this prints.
 *
 * An item (a component state, a part of a build) is tail, and is
 * handed to a background unit or left with its reason, as soon as any
 * of these holds:
 *   1. the gate is reached: the usable result exists (the import ran,
 *      the page copy is composed and the change written); whatever is
 *      not matched at that moment is tail, whatever it is;
 *   2. it is small: its remaining difference is under a share of the
 *      whole, or its verdict already counts as matching;
 *   3. it is not the item's fault: explain-diff lays the difference on
 *      something outside it (what the page paints under or over it,
 *      another surface's colour, an element that is gone);
 *   4. diminishing returns: two passes in a row each cut the mismatch
 *      by under a fifth, or a pass made it worse;
 *   5. the unit's budget: three checks or two minutes;
 *   6. someone is waiting: a site command is queued (one being handled
 *      right now is not queued: `handling` marks it; nor is an answer
 *      to a build's question, which its build takes).
 * And a phase (the import's tail, a build's copy) is weighed as a
 * whole from two minutes in: P(t), the matched share of the work by
 * weight, sampled at every check pass; every thirty seconds the gain
 * over the last window forecasts what thirty more seconds would bring,
 * and the phase moves on when that is little, when it has plateaued,
 * when it regressed, or when the rest is minutes away.
 *
 * The gate never waits on any of this. The moment the import or the
 * copy is usable, the agent says so; the tail's units run in the
 * background on their own budgets (rule 5), and `decide` only reads
 * the numbers as they stand. It returns at once, always: the forecast
 * says whether the rest is worth a look later, never whether to hold
 * the foreground.
 *
 * Every pass and every decision is recorded in tail.jsonl in the run
 * folder (the codebase's run/, or the build's), so a run says when and
 * why it moved on.
 *
 * Usage:
 *   node tools/tail.mjs decide <codebase> [--build <briefId>]
 *       the phase's decision now, at once. One JSON line on stdout:
 *       { action: continue|move-on|done, line, matched, total, P,
 *       gain, eta }; the line is for the user as it stands.
 *   node tools/tail.mjs waiting <codebase>
 *       whether a site command is queued for this codebase (rule 6).
 *   node tools/tail.mjs handling <codebase> <offset>
 *       the feed line ending at <offset> is being handled now: it is
 *       not waiting (the listen skill runs this before acting).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const TAIL = {
  // The first moment a phase weighs moving on: two minutes in, most of
  // what will match has, and what has not is the tail by then.
  CHECKPOINT_MS: 120_000,
  // A window long enough for a check pass to land in, short enough that
  // thirty seconds' patience is all a wrong forecast costs.
  WINDOW_MS: 30_000,
  // Worth another window: the next one is forecast to gain at least this
  // share of what is left, or one whole item.
  MEANINGFUL_GAIN: 0.05,
  // Worth waiting for at all: the remainder is forecast done within a minute.
  ETA_CONTINUE_MS: 60_000,
  // Not worth waiting for: more than two minutes to go.
  ETA_BAIL_MS: 120_000,
  // A window that gains under this share of the remainder is flat; two
  // flat windows in a row are a plateau.
  FLAT_GAIN: 0.01,
  // A part whose difference is under this share of the page's pixels is
  // a detail the eye does not settle on (a resizer's three-pixel column).
  SMALL_PART_SHARE: 0.005,
  // A state whose difference is under this share of the component's own
  // pixels is a hairline, not a look.
  SMALL_STATE_SHARE: 0.01,
  // A pass that cuts the mismatch by less than this share is not
  // progress; two such passes in a row are a stop.
  PASS_GAIN: 0.2,
  // A unit's outer bounds, whatever the trend.
  UNIT_CHECKS: 3,
  UNIT_MS: 120_000,
  // A composed page that differs from the reference by no more than this
  // share of its pixels is a copy the change can be written on; the
  // rest is detail the parts' units chase in the background.
  PAGE_PROCEED_PCT: 0.5,
};

// Verdicts that count as the product's look (tools/check.mjs ACCEPTED).
const ACCEPTED = new Set(["match", "shifted", "context", "faint", "offscreen"]);

/** Where a run's tail record lives: the codebase's run folder, or the build's. */
export function tailFile(codebase, briefId = null) {
  const run = join(process.env.HOME ?? "", ".proto", codebase, "run");
  return briefId ? join(run, "builds", briefId, "tail.jsonl") : join(run, "tail.jsonl");
}

/** Append one record: { kind: phase | pass | item | decision, ... } with its time. */
export function record(file, entry) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: Date.now(), ...entry }) + "\n");
}

export function readRecords(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Rule 2: a state whose difference is small, or whose verdict already
 * counts as matching. `area` is the state's pixels (device px).
 */
export function classifyState({ verdict, mismatch, area }, share = TAIL.SMALL_STATE_SHARE) {
  if (ACCEPTED.has(verdict)) return { tail: true, rule: "accepted", reason: `its ${verdict} verdict counts as the product's look` };
  if (verdict !== "differs" || !Number.isFinite(mismatch) || !area) return { tail: false, rule: null, reason: null };
  const fraction = mismatch / area;
  if (fraction < share) return { tail: true, rule: "small", reason: `its difference is ${pct(fraction)} of its area, under ${pct(share)}` };
  return { tail: false, rule: null, reason: null };
}

/** Rule 2 for a part of a build: its difference against the page's pixels. */
export function classifyPart({ verdict, mismatch, pageArea }) {
  return classifyState({ verdict, mismatch, area: pageArea }, TAIL.SMALL_PART_SHARE);
}

/**
 * Rule 4: from an item's mismatch over its passes, whether the last two
 * passes made progress. Flat or worse for two passes is a stop; one
 * pass that made it worse is a stop.
 */
export function passTrend(mismatches) {
  const m = mismatches.filter((v) => Number.isFinite(v));
  if (m.length < 2) return { stop: false, reason: null };
  const last = m[m.length - 1];
  const before = m[m.length - 2];
  if (last > before) return { stop: true, reason: `the last change made it worse (${before} to ${last} px)` };
  const gain = (a, b) => (a === 0 ? 1 : (a - b) / a);
  if (m.length >= 3) {
    const g1 = gain(m[m.length - 3], before);
    const g2 = gain(before, last);
    if (g1 < TAIL.PASS_GAIN && g2 < TAIL.PASS_GAIN) return { stop: true, reason: `two passes in a row improved it by under ${pct(TAIL.PASS_GAIN)} (${m[m.length - 3]}, ${before}, ${last} px)` };
  }
  return { stop: false, reason: null };
}

/** Rule 5: a unit's checks and minutes. */
export function unitBudget({ checks, startedAt, now = Date.now() }) {
  if (checks >= TAIL.UNIT_CHECKS) return { stop: true, reason: `${checks} checks made, the unit's budget` };
  if (now - startedAt >= TAIL.UNIT_MS) return { stop: true, reason: `${Math.round((now - startedAt) / 1000)} s spent, the unit's budget` };
  return { stop: false, reason: null };
}

/** Where the listen skill records the feed line it is acting on: { offset } like offset.json. */
export function handlingFile(codebase) {
  return join(process.env.HOME ?? "", ".proto", codebase, "run", "courier", "handling.json");
}

/**
 * Rule 6: whether a site command is queued for this codebase: the
 * courier's feed holds a line past the committed offset and past the
 * line being handled. The listen skill commits the offset only after
 * acting on a line, so the command whose work this is stays in the
 * feed the whole time; without the handling mark it counted as
 * waiting on itself, and a build said a site command was waiting
 * about its own brief.
 */
export function waiting(codebase) {
  const run = join(process.env.HOME ?? "", ".proto", codebase, "run", "courier");
  const feed = join(run, "commands.jsonl");
  if (!existsSync(feed)) return { waiting: false, what: null };
  const offsetIn = (file) => {
    try {
      const value = JSON.parse(readFileSync(file, "utf8")).offset;
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  };
  // Nothing committed yet: everything in the feed waits, except the line in hand.
  const offset = Math.max(offsetIn(join(run, "offset.json")), offsetIn(handlingFile(codebase)));
  const size = statSync(feed).size;
  if (size <= offset) return { waiting: false, what: null };
  // An answer to a build's question is never work waiting: its build
  // takes it, or the listen skill drops it.
  const pending = readFileSync(feed, "utf8")
    .slice(offset)
    .split("\n")
    .filter(Boolean)
    .filter((line) => !isAnswer(line));
  if (pending.length === 0) return { waiting: false, what: null };
  let what = "a site command";
  try {
    const command = JSON.parse(pending[0]);
    if (command.run) what = `${/^[aeiou]/i.test(command.run) ? "an" : "a"} ${command.run} command from the site`;
  } catch {
    // An unreadable line still waits.
  }
  return { waiting: true, what, count: pending.length };
}

function isAnswer(line) {
  try {
    return JSON.parse(line).run === "answer";
  } catch {
    return false;
  }
}

/**
 * The matched share of a phase's work by weight at a moment: an item
 * counts once every state it has been checked in is accepted in its
 * latest pass at or before `at`. Items come from the phase record;
 * passes from the pass records.
 */
export function progressAt(records, at) {
  const phase = [...records].reverse().find((r) => r.kind === "phase");
  if (!phase) return null;
  const items = new Map(phase.items.map((item) => [item.item, item.weight]));
  const total = [...items.values()].reduce((a, b) => a + b, 0);
  const latest = new Map(); // item → Map(state → verdict)
  for (const r of records) {
    if (r.kind !== "pass" || r.at > at || r.at < phase.at || !items.has(r.item)) continue;
    if (!latest.has(r.item)) latest.set(r.item, new Map());
    latest.get(r.item).set(r.state, r.verdict);
  }
  // An item the phase already lists as matched stays matched.
  let matched = 0;
  let count = 0;
  for (const item of phase.items) {
    const states = latest.get(item.item);
    const ok = item.matched === true || (states !== undefined && [...states.values()].every((v) => ACCEPTED.has(v)));
    if (ok) {
      matched += item.weight;
      count++;
    }
  }
  return { P: total === 0 ? 1 : matched / total, matched: count, total: phase.items.length, remainingWeight: total - matched, phaseAt: phase.at, items: phase.items, latest };
}

/**
 * The phase's decision now. Before the checkpoint only rule 6 decides;
 * from it, the last two windows' gains forecast the next.
 */
export function decide(records, codebase, now = Date.now()) {
  const here = progressAt(records, now);
  if (!here) return { action: "done", line: "Nothing is being fixed.", matched: 0, total: 0 };
  const rest = here.total - here.matched;
  const of = `${here.matched} of ${here.total} matched`;
  if (rest === 0) return { action: "done", line: `Done: ${of}.`, ...numbers(here) };
  const queued = waiting(codebase);
  if (queued.waiting) return { action: "move-on", line: `Moving on: ${of}; ${queued.what} is waiting. The rest keeps going in the background.`, ...numbers(here), rule: "waiting" };
  const elapsed = now - here.phaseAt;
  if (elapsed < TAIL.CHECKPOINT_MS) return { action: "continue", line: `Fixing in the background: ${of}; nothing waits on the rest.`, ...numbers(here) };
  const before = progressAt(records, now - TAIL.WINDOW_MS);
  const earlier = progressAt(records, now - 2 * TAIL.WINDOW_MS);
  const gain = here.P - before.P;
  const gainBefore = before.P - earlier.P;
  const remaining = 1 - here.P;
  const eta = gain > 0 ? (remaining / gain) * TAIL.WINDOW_MS : Infinity;
  const minutesLeft = Math.max(1, Math.round(eta / 60_000));
  const minutes = eta === Infinity ? "no end in sight" : `about ${minutesLeft} more minute${minutesLeft === 1 ? "" : "s"} to go`;
  const lastMinute = `the rest improved ${pct(gain + gainBefore)} in the last minute`;
  const tail = `The rest keeps going in the background.`;
  const base = { ...numbers(here), gain, gainBefore, eta };
  if (gain < 0) return { action: "move-on", rule: "regressing", line: `Moving on: ${of}; the last window made it worse. ${tail}`, ...base };
  if (gain < TAIL.FLAT_GAIN * remaining && gainBefore < TAIL.FLAT_GAIN * remaining) return { action: "move-on", rule: "plateau", line: `Moving on: ${of}; nothing has improved in the last minute. ${tail}`, ...base };
  if (eta > TAIL.ETA_BAIL_MS) return { action: "move-on", rule: "eta", line: `Moving on: ${of}; ${lastMinute}, ${minutes}. ${tail}`, ...base };
  const smallest = Math.min(...here.items.filter((item) => !(here.latest.get(item.item) && [...here.latest.get(item.item).values()].every((v) => ACCEPTED.has(v))) && item.matched !== true).map((item) => item.weight));
  const totalWeight = here.items.reduce((a, item) => a + item.weight, 0);
  const meaningful = gain >= TAIL.MEANINGFUL_GAIN * remaining || gain * totalWeight >= smallest;
  if (meaningful && eta <= TAIL.ETA_CONTINUE_MS) return { action: "continue", rule: "forecast", line: `Fixing in the background: ${of}; ${lastMinute}, ${minutes}.`, ...base };
  return { action: "move-on", rule: "little-gain", line: `Moving on: ${of}; ${lastMinute}, ${minutes}. ${tail}`, ...base };
}

/**
 * The page copy's forecast at its gate (tools/copy-gate.mjs), from the
 * last two copy passes: `before` and `after` are the matched share of
 * the page (0 to 1) either side of the last pass, which took `passMs`.
 * Another pass helps when the last one gained a meaningful share of
 * what was left; it would take about as long as the last one.
 */
export function copyForecast({ before, after, passMs }) {
  const left = 1 - before;
  const gain = after - before;
  const minutes = Math.max(1, Math.round(passMs / 60_000));
  const verdict = left > 0 && gain >= TAIL.MEANINGFUL_GAIN * left ? "another-pass-helps" : "little-gain";
  return { verdict, gain, minutes };
}

const numbers = (here) => ({ matched: here.matched, total: here.total, P: Math.round(here.P * 1000) / 1000 });
const pct = (fraction) => `${Math.round(fraction * 1000) / 10}%`;

// ---- command line ----

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = {};
  const positional = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      options[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else positional.push(args[i]);
  }
  const [command, codebase, offsetArg] = positional;
  const usage = () => {
    console.error("usage: node tools/tail.mjs decide <codebase> [--build <briefId>] | waiting <codebase> | handling <codebase> <offset>");
    process.exit(1);
  };
  if (!command || !codebase) usage();
  if (command === "waiting") {
    console.log(JSON.stringify(waiting(codebase)));
    process.exit(0);
  }
  if (command === "handling") {
    const offset = Number(offsetArg);
    if (!Number.isInteger(offset) || offset < 0) usage();
    const file = handlingFile(codebase);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ offset, at: new Date().toISOString() }) + "\n");
    console.log(JSON.stringify({ handling: offset }));
    process.exit(0);
  }
  if (command !== "decide") usage();
  if ("wait" in options) console.error("tail.mjs decide no longer waits: the gate is reported at once and the tail runs in the background; printing the decision now");
  const file = tailFile(codebase, options.build ?? null);
  const decision = decide(readRecords(file), codebase);
  record(file, { kind: "decision", ...decision });
  console.error(decision.line);
  console.log(JSON.stringify(decision));
}
