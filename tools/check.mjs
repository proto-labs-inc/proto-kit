#!/usr/bin/env node
/**
 * Check a component against the product, every state in one call, and
 * land each pass in the library the moment it is made, so the user
 * watches the checks arrive while the component is still being read.
 *
 * Usage: node tools/check.mjs <codebase> <slug> [--state <name>] [--no-land] [--activity "<line>"]
 *
 * Reads src/components/<slug>/component.json. Every state whose entry
 * carries `live` (where the product shows it) is checked:
 *   { "name": "Hover", "props": { "interaction": "hover" },
 *     "live": { "selector": "<css>", "force": "hover" } }
 * `selector` names the live element (tools/snapshot.mjs writes it);
 * `force` holds a pseudo-class on it for the capture. A state without
 * `live` has no instance on the page and is not checked. --state
 * checks one state only.
 *
 * Each pass is one tools/verify-replica.mjs pass (same display as the
 * Proto window, the live rect read at full precision) and is landed
 * with `library.mjs history` carrying the product capture, our render
 * and the difference; --no-land keeps them out of the library.
 * --activity replaces the pass's line (a unit saying what it changed).
 *
 * Prints one JSON line: { slug, states: [{ state, verdict, mismatch,
 * shifted, clusters, activity }], matched } where matched is true when
 * every checked state's verdict is match, shifted, context, faint or
 * offscreen (tools/verify-replica.mjs says what each means).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPass } from "./verify-replica.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
// Verdicts that count as the product's look: identical, a one-pixel
// placement, or identical where the page shows it.
const ACCEPTED = ["match", "shifted", "context", "faint", "offscreen"];
const USAGE = 'usage: node tools/check.mjs <codebase> <slug> [--state <name>] [--no-land] [--activity "<line>"]';

const options = { land: true };
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

const home = join(process.env.HOME ?? "", ".proto", codebase);
const library = join(home, "library");
const unitPath = join(library, "src", "components", slug, "component.json");
if (!existsSync(unitPath)) {
  console.error(`${unitPath} does not exist: write the component (tools/snapshot.mjs) before checking it`);
  process.exit(1);
}
const unit = JSON.parse(readFileSync(unitPath, "utf8"));
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
const appUrl = `http://localhost:${JSON.parse(readFileSync(tunnel, "utf8")).port}`;
const page = new URL(liveUrl);
const liveMatch = `${page.host}${page.pathname}`;

let states = unit.states.filter((s) => s.live);
if (options.state) states = states.filter((s) => s.name === options.state);
if (states.length === 0) {
  console.error(options.state ? `state "${options.state}" has no live instance in component.json` : "no state in component.json names a live instance");
  process.exit(1);
}

const out = join(home, "run", "checks", slug);
mkdirSync(out, { recursive: true });
// A minute per state: a pass waits for the window's lock behind other
// lanes, and a state that differs is checked twice.
const budget = 60_000 * states.length * 2;
setTimeout(() => {
  console.error(`check gave up after ${budget / 1000}s: a capture never completed; check the live tab is still open and try again`);
  process.exit(2);
}, budget).unref();

// One state at a time: a pseudo-class held on the live element for one
// state must not leak into another state's capture.
const results = [];
for (const state of states) {
  const pass = (frame) =>
    verifyPass({ appUrl, slug, state: state.name, liveMatch, target: { selector: state.live.selector }, force: state.live.force, out, codebase: frame ? codebase : undefined });
  let result;
  try {
    result = await pass(true);
    // A state that differs is checked once more before it counts, against
    // the live page itself: the first may have caught the tail of another
    // state's transition, or a resting frame taken at a bad moment.
    if (!ACCEPTED.includes(result.verdict)) result = await pass(false);
  } catch (error) {
    results.push({ state: state.name, verdict: "failed", error: error.message });
    continue;
  }
  const activity = options.activity ?? label(state.name, result.activity);
  if (options.land) land(result, activity);
  results.push({
    state: state.name,
    verdict: result.verdict,
    mismatch: result.mismatch,
    shifted: result.shifted,
    clusters: result.clusters.slice(0, 4),
    activity,
  });
}
const matched = results.every((r) => ACCEPTED.includes(r.verdict));
console.log(JSON.stringify({ slug, states: results, matched }));

// The pass's line names the state when the component has more than one.
function label(stateName, activity) {
  if (unit.states.length === 1) return activity;
  return `${stateName}: ${activity.charAt(0).toLowerCase()}${activity.slice(1)}`;
}

function land(result, activity) {
  const landed = spawnSync(
    process.execPath,
    [
      join(kit, "tools", "library.mjs"),
      "history",
      library,
      slug,
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
