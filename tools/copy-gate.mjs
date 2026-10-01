/**
 * The page copy's gate, when the copy is not usable yet: the composed
 * page differs from the reference by more than TAIL.PAGE_PROCEED_PCT
 * (or did not mount). The copy is tried once more by itself, after the
 * page settles; only if it is still over the gate is the person asked,
 * in the current conversation, whether to start building anyway:
 *
 *   "Start building before the copy is finished?"
 *     finish  "Not yet, finish it"    another copy pass
 *     build   "Yes, start building"   the change is written on this copy
 *   or a reply of their own, which the agent follows as an instruction.
 *
 * The question carries how much of the page is copied (the matched
 * parts' share of the page's area), the parts that never matched (listed
 * in the chat question and read-only site history), what starting now means and
 * how long finishing takes. The recommended option comes from
 * tail.mjs's forecast: "finish" when the last pass gained enough that
 * another one helps, else "build". A pending question returns immediately and resumes from
 * its saved checkpoint after an explicit chat answer.
 */
import { randomUUID } from "node:crypto";
import { copyForecast } from "./tail.mjs";

export const COPY_GATE_OPTIONS = [
  { id: "finish", label: "Not yet, finish it" },
  { id: "build", label: "Yes, start building" },
];

const MAX_MISSING = 40;
const MAX_SUGGESTION = 80;

const areaOf = (rect) => Math.max(1, Math.round((rect?.w ?? 0) * (rect?.h ?? 0)));

// Pictures are copied as the page's own files; one that never matched can stand in as a placeholder.
const PICTURE = /(^|[\s>])(img|svg|picture|canvas)\b/;

/** The matched parts' share of the page's parts by area, 0 to 1. */
export function matchedShare(replicated, tree) {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  let matched = 0;
  let total = 0;
  for (const part of replicated.parts ?? []) {
    const area = areaOf(nodes.get(part.id)?.rect);
    total += area;
    if (part.status === "matched") matched += area;
  }
  return total === 0 ? 0 : matched / total;
}

/** The parts that never matched, largest first: { id, name, picture }. */
export function missingParts(replicated, tree) {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const names = new Map((tree.curation ?? []).map((entry) => [entry.id, entry.name]));
  return (replicated.parts ?? [])
    .filter((part) => part.status !== "matched")
    .map((part) => {
      const node = nodes.get(part.id);
      return { id: part.id, name: names.get(part.id) ?? part.slug, picture: PICTURE.test(node?.raw ?? ""), area: areaOf(node?.rect) };
    })
    .sort((a, b) => b.area - a.area)
    .map(({ area: _, ...part }) => part);
}

const minutesText = (minutes) => (minutes === 1 ? "a minute" : `${minutes} minutes`);

/** A suggestion that fits the site's 80 characters, the part's name shortened when it must be. */
function suggestion(before, name) {
  const room = MAX_SUGGESTION - before.length;
  return before + (name.length > room ? `${name.slice(0, room - 1)}…` : name);
}

/** The copy-gate question's fields (questionEvent's, without the id). */
export function copyGateQuestion({ copied, missing, forecast }) {
  const finishing = `Finishing the copy takes about ${minutesText(forecast.minutes)} more.`;
  let impact = `If you start now, the page around your change won't match yours yet. ${finishing}`;
  if (missing.length > 0) impact = `If you start now, your prototype won't show them yet. They'll be empty spaces, and your change is built around them. ${finishing}`;
  const suggestions = [];
  if (missing.length > 0) {
    suggestions.push(suggestion("Finish only the ", missing[0].name), suggestion("Skip the ", missing[0].name));
  }
  if (missing.some((part) => part.picture)) suggestions.push("Use a placeholder image");
  return {
    form: "copy-gate",
    text: "Start building before the copy is finished?",
    impact,
    options: COPY_GATE_OPTIONS,
    recommended: forecast.verdict === "another-pass-helps" ? "finish" : "build",
    suggestions: suggestions.slice(0, 3),
    copied: Math.round(copied * 100),
    missing: missing.slice(0, MAX_MISSING).map((part) => part.id),
  };
}

/**
 * Takes the copy through its gate. `replicated` is replicate.mjs's
 * result; `copy()` runs another copy pass and resolves its result;
 * `settle()` lets the page come to rest and captures it afresh;
 * `ask(fields)` sends a question and resolves its id; `wait(id)`
 * resolves the answer ({ by, option?, text? }). Resolves
 *   { outcome: "proceed", replicated }         the copy passed its gate
 *   { outcome: "build", replicated, answer }   start on this copy anyway
 *   { outcome: "reply", replicated, answer }   the person wrote what to do
 *   { outcome: "needs-input", replicated, pending }  answer in the current chat
 * `checkpoint` and `save` keep the latest retry and pending question, so
 * resuming an unanswered gate does not capture or copy the page again.
 */
export async function passGate({ replicated, tree, copy, settle, ask, wait, checkpoint = null, save = () => {}, say = () => {}, now = Date.now }) {
  if (checkpoint?.outcome) return { outcome: checkpoint.outcome, replicated: checkpoint.replicated, ...(checkpoint.answer ? { answer: checkpoint.answer } : {}) };
  if (replicated.gate?.proceed) return { outcome: "proceed", replicated };
  let current = checkpoint?.replicated ?? replicated;
  let questionId = checkpoint?.questionId ?? null;
  let attempt = checkpoint?.attempt ?? 0;
  const generation = checkpoint?.generation ?? randomUUID();
  let last = checkpoint?.last ?? null;
  const keep = (extra = {}) => save({ replicated: current, last, questionId, attempt, generation, ...extra });
  const done = async (outcome, answer) => {
    await keep({ outcome, ...(answer ? { answer } : {}) });
    return { outcome, replicated: current, ...(answer ? { answer } : {}) };
  };
  // The retry lets the page come to rest first; a pass the person asks for runs right away.
  const pass = async (when) => {
    const before = matchedShare(current, tree);
    const began = now();
    if (when === "after-settling") await settle();
    current = await copy();
    return { before, passMs: now() - began };
  };
  if (!last) {
    say(`the copy is over its gate (${current.gate?.line ?? "no gate line"}); copying once more after the page settles`);
    last = await pass("after-settling");
    await keep();
  }
  for (;;) {
    if (current.gate?.proceed) return done("proceed");
    const after = matchedShare(current, tree);
    const forecast = copyForecast({ before: last.before, after, passMs: last.passMs });
    const fields = copyGateQuestion({ copied: after, missing: missingParts(current, tree), forecast });
    say(`still over the gate: asking whether to start building (${fields.copied}% copied, recommended: ${fields.recommended})`);
    if (!questionId) {
      questionId = await ask(fields, `copy-gate-${generation}-${attempt}`);
      await keep();
    }
    const answer = await wait(questionId);
    if (answer.status === "needs-input") return { outcome: "needs-input", replicated: current, pending: answer };
    if (answer.by === "reply") return done("reply", answer);
    if (answer.option === "build") return done("build", answer);
    if (answer.option !== "finish") throw new Error(`unknown copy-gate answer: ${JSON.stringify(answer)}`);
    say("finishing the copy: another pass");
    questionId = null;
    attempt += 1;
    last = await pass("right-away");
    await keep();
  }
}
