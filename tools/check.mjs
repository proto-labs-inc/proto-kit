#!/usr/bin/env node
/**
 * Check a component against the product, every state in one call, and
 * land each pass in the library the moment it is made, so the user
 * watches the checks arrive while the component is still being read.
 *
 * Usage: node tools/check.mjs <codebase> <slug> [--theme <light|dark>] [--state <name>] [--no-land] [--activity "<line>"]
 *        node tools/check.mjs <codebase> <slug> --app <url> --unit <component.json> --live <page-url> [--out <dir>] [--theme <light|dark>] [--state <name>]
 *
 * The first form checks a library component: src/components/<slug>/
 * in ~/.proto/<codebase>/library, rendered by the library app at its
 * tunnel port, against the page codebase.json names. The second names
 * the target itself, for a part of a prototype workspace: the app that
 * serves the render route (`--app`), the part's component.json
 * (`--unit`), the live page it was read from (`--live`) and where the
 * pictures go (`--out`); nothing is landed in the library.
 * tools/replicate.mjs calls the same check in-process (`checkComponent`).
 *
 * Every state whose entry carries `live` (where the product shows it)
 * is checked:
 *   { "name": "Hover", "props": { "interaction": "hover" },
 *     "live": { "selector": "<css>", "force": "hover" } }
 * `selector` names the live element (tools/snapshot.mjs writes it);
 * `force` holds a pseudo-class on it for the capture; `fallback`, when
 * the selector is positional, names the same element without a position
 * and is used once the selector no longer names it (tools/live-selector.mjs).
 * A state without
 * `live` has no instance on the page and is not checked. --state
 * checks one state only.
 *
 * Each pass is one tools/verify-replica.mjs pass (same display as the
 * Proto window, the live rect read at full precision) and, for a
 * library component, is landed with `library.mjs history` carrying the
 * product capture, our render and the difference; --no-land keeps them
 * out. --activity replaces the pass's line (a unit saying what it changed).
 *
 * Prints one JSON line: { slug, states: [{ state, verdict, mismatch,
 * area, shifted, clusters, activity, tail }], matched, typecheck,
 * stop, restored } where matched is true when every checked state's
 * verdict is match, shifted, context, faint or offscreen
 * (tools/verify-replica.mjs says what each means); `stop` is not a
 * match. `typecheck` lists the component's own type errors. Every pass
 * is recorded in the run's tail.jsonl (tools/tail.mjs); a state's
 * `tail` says when a unit should stop on it and why (its difference is
 * small, the last passes did not help, the unit's budget is spent),
 * and `stop` when that holds for every state that still differs: the
 * unit reports then, instead of another pass, and the component is put
 * back as the import wrote it (`restored`, tools/unit-restore.mjs).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyState, passTrend, readRecords, record, tailFile, unitBudget } from "./tail.mjs";
import { restoreFolder } from "./unit-restore.mjs";
import { nextPass, verifyPass } from "./verify-replica.mjs";
import { resolveStates } from "./live-selector.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
// Verdicts that count as the product's look: identical, a one-pixel
// placement, or identical where the page shows it.
export const ACCEPTED = ["match", "shifted", "context", "faint", "offscreen"];
const USAGE = 'usage: node tools/check.mjs <codebase> <slug> [--theme <light|dark>] [--state <name>] [--no-land] [--activity "<line>"] [--app <url> --unit <component.json> --live <page-url> --out <dir>]';

/** The part of a page address a tab is found by: its host and path. */
export function liveMatchOf(url) {
  const page = new URL(url);
  return `${page.host}${page.pathname}`;
}

/**
 * Check every live state of one component: `unit` is its component.json
 * (parsed), `appUrl` the app serving the render route, `liveMatch` the
 * live tab, `out` where the pictures go, `codebase` lets a resting
 * state be cut from the run's frame. Each state is checked at once
 * (the window's lock keeps held states apart), and a state that differs
 * is checked once more against the live page itself. -> { states, matched }
 * where each state carries its full pass result.
 */
export async function checkComponent({ unit, slug, appUrl, liveMatch, out, codebase, only = null, port = 9333, theme = "light" }) {
  let states = unit.states.filter((s) => s.live);
  if (only) states = states.filter((s) => s.name === only);
  if (states.length === 0) throw new Error(only ? `state "${only}" has no live instance in component.json` : "no state in component.json names a live instance");
  mkdirSync(out, { recursive: true });
  // A positional selector the page has shifted under resolves to the
  // position-free one snapshot.mjs recorded beside it.
  states = await resolveStates(states, liveMatch, port);
  // Each state has its own pass numbers (two per state: its check and a
  // possible second look), so none collide.
  const first = nextPass(out);
  const results = await Promise.all(
    states.map(async (state, k) => {
      const pass = (frame, n) =>
        verifyPass({ appUrl, slug, state: state.name, liveMatch, target: { selector: state.live.selector }, force: state.live.force, out, codebase: frame ? codebase : undefined, pass: n, port, theme });
      try {
        let result = await pass(true, first + k * 2);
        // A state that differs is checked once more before it counts, against
        // the live page itself: the first may have caught the tail of another
        // state's transition, or a resting frame taken at a bad moment.
        if (!ACCEPTED.includes(result.verdict)) result = await pass(false, first + k * 2 + 1);
        return { state: state.name, result };
      } catch (error) {
        return { state: state.name, verdict: "failed", error: error.message };
      }
    }),
  );
  const matched = results.every((entry) => entry.result && ACCEPTED.includes(entry.result.verdict));
  return { states: results, matched };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = { land: true, theme: "light" };
  const positional = [];
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--no-land") options.land = false;
    else if (args[i].startsWith("--")) {
      options[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else positional.push(args[i]);
  }
  const [codebase, slug] = positional;
  if (!codebase || !slug) {
    console.error(USAGE);
    process.exit(1);
  }
  if (!["light", "dark"].includes(options.theme)) {
    console.error("--theme is light or dark");
    process.exit(1);
  }
  const home = join(process.env.HOME ?? "", ".proto", codebase);
  const library = join(home, "library");

  // The library's component unless the target is named.
  let target;
  if (options.app || options.unit || options.live) {
    if (!options.app || !options.unit || !options.live) {
      console.error("--app, --unit and --live go together: the app serving the render route, the part's component.json and the live page");
      process.exit(1);
    }
    target = { unitPath: options.unit, appUrl: options.app, liveUrl: options.live, out: options.out ?? join(dirname(options.unit), "checks"), land: false };
  } else {
    const unitPath = join(library, "src", "components", slug, "component.json");
    const liveUrl = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source?.liveUrl;
    if (!liveUrl) {
      console.error(`${home}/codebase.json has no source.liveUrl: the product page setup opened in the Proto window`);
      process.exit(1);
    }
    const tunnel = join(home, "run", "library", "tunnel.json");
    if (!existsSync(tunnel)) {
      console.error(`the library is not being served: run node tools/host-library.mjs ${codebase}`);
      process.exit(1);
    }
    target = { unitPath, appUrl: `http://localhost:${JSON.parse(readFileSync(tunnel, "utf8")).port}`, liveUrl, out: join(home, "run", "checks", slug), land: options.land };
  }
  if (!existsSync(target.unitPath)) {
    console.error(`${target.unitPath} does not exist: write the component (tools/snapshot.mjs) before checking it`);
    process.exit(1);
  }
  const unit = JSON.parse(readFileSync(target.unitPath, "utf8"));
  const states = unit.states.filter((s) => s.live && (!options.state || s.name === options.state));
  // A minute per state: a pass waits for the window's lock behind other
  // lanes, and a state that differs is checked twice.
  const patience = 60_000 * Math.max(1, states.length) * 2;
  setTimeout(() => {
    console.error(`check gave up after ${patience / 1000}s: a capture never completed; check the live tab is still open and try again`);
    process.exit(2);
  }, patience).unref();
  let checked;
  try {
    checked = await checkComponent({ unit, slug, appUrl: target.appUrl, liveMatch: liveMatchOf(target.liveUrl), out: target.out, codebase, only: options.state ?? null, theme: options.theme });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  // Landed in the order of component.json, so the history reads state by state.
  for (const entry of checked.states) {
    if (!entry.result) continue;
    entry.activity = options.activity ?? label(unit, entry.state, entry.result.activity);
    if (target.land) land(library, slug, entry.result, entry.activity, options.theme);
  }
  // Every pass goes on the run's record, and the unit's own budget
  // counts from its first check after the import's gate.
  const tail = tailFile(codebase);
  const before = readRecords(tail);
  const phaseAt = [...before].reverse().find((r) => r.kind === "phase")?.at ?? 0;
  const own = before.filter((r) => r.at >= phaseAt && r.item === slug);
  const checks = own.filter((r) => r.kind === "check").length + 1;
  const startedAt = own.find((r) => r.kind === "check")?.at ?? Date.now();
  record(tail, { kind: "check", item: slug });
  const summary = checked.states.map((entry) => {
    if (!entry.result) return entry;
    const { result, activity } = entry;
    const area = Math.round(result.rect[2] * result.rect[3] * result.display.dpr * result.display.dpr);
    record(tail, { kind: "pass", item: slug, state: entry.state, verdict: result.verdict, mismatch: result.mismatch, area });
    const history = [...own.filter((r) => r.kind === "pass" && r.state === entry.state).map((r) => r.mismatch), result.mismatch];
    const stop = stopReason({ verdict: result.verdict, mismatch: result.mismatch, area, history, checks, startedAt });
    return { state: entry.state, verdict: result.verdict, mismatch: result.mismatch, area, shifted: result.shifted, clusters: result.clusters.slice(0, 4), activity, tail: stop };
  });
  // A state whose check failed outright (the render route did not mount) has no tail verdict: it is checked again, not stopped on.
  const differing = summary.filter((s) => s.tail && !ACCEPTED.includes(s.verdict));
  const stop = differing.length > 0 && differing.every((s) => s.tail.stop);
  for (const s of differing) if (s.tail.stop) console.error(`${slug} ${s.state}: stop here, ${s.tail.reason}`);
  // A library component's own type errors, from the library's tsc; a
  // component with errors of its own is not done, whatever the pixels say.
  const typecheck = target.land ? typecheckFolder(library, `src/components/${slug}/`) : { ok: true, errors: [] };
  if (!typecheck.ok) console.error(`${slug}: ${typecheck.errors.length} type error${typecheck.errors.length === 1 ? "" : "s"} in the component's own files; the component is not done until they are gone`);
  // The budget spent without a match: the component goes back to how the
  // import wrote it, from the copy explain-diff kept (tools/unit-restore.mjs).
  let restored = false;
  if (stop && !checked.matched && target.land) {
    const back = restoreFolder({ folder: dirname(target.unitPath), slug, runDir: join(home, "run") });
    restored = back.restored;
    if (restored) console.error(`${slug}: restored ${dirname(target.unitPath)} to how the import wrote it (from ${back.path})`);
  }
  console.log(JSON.stringify({ slug, states: summary, matched: checked.matched, typecheck, stop, restored }));
}

/** A folder's tsc errors, from the app's own typecheck script, kept to the files under `prefix`. */
function typecheckFolder(app, prefix) {
  const result = spawnSync("pnpm", ["-s", "typecheck"], { cwd: app, encoding: "utf8" });
  if (result.error) return { ok: false, errors: [`typecheck could not run: ${result.error.message}`] };
  const errors = `${result.stdout}\n${result.stderr}`.split("\n").filter((line) => line.startsWith(prefix) && /error TS\d+/.test(line));
  return { ok: errors.length === 0, errors: errors.slice(0, 12) };
}

/**
 * Whether a unit should stop on this state, and why (tools/tail.mjs
 * rules 2, 4 and 5): a difference too small to chase, passes that no
 * longer help, or a budget spent. Never on a state that matches.
 */
function stopReason({ verdict, mismatch, area, history, checks, startedAt }) {
  if (ACCEPTED.includes(verdict)) return { stop: false, reason: null };
  const small = classifyState({ verdict, mismatch, area });
  if (small.tail) return { stop: true, rule: small.rule, reason: small.reason };
  const trend = passTrend(history);
  if (trend.stop) return { stop: true, rule: "diminishing", reason: trend.reason };
  const budget = unitBudget({ checks, startedAt });
  if (budget.stop) return { stop: true, rule: "budget", reason: budget.reason };
  return { stop: false, reason: null };
}

// The pass's line names the state when the component has more than one.
function label(unit, stateName, activity) {
  if (unit.states.length === 1) return activity;
  return `${stateName}: ${activity.charAt(0).toLowerCase()}${activity.slice(1)}`;
}

function land(library, slug, result, activity, theme) {
  const landed = spawnSync(
    process.execPath,
    [
      join(kit, "tools", "library.mjs"),
      "history",
      library,
      slug,
      "--theme",
      theme,
      "--screenshot",
      result.screenshot,
      "--diff",
      result.diff,
      "--live",
      result.live,
      "--verdict",
      result.verdict,
      "--mismatch",
      String(result.mismatch),
      "--activity",
      activity,
    ],
    { encoding: "utf8" },
  );
  if (landed.status !== 0) console.error(`could not land the pass: ${landed.stderr.trim()}`);
}
