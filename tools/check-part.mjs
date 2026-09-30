#!/usr/bin/env node
/**
 * One part of a prototype build checked against the reference page,
 * with its passes streamed to the site: what a part-fixer unit runs
 * after each change to src/parts/<slug>/. The part's component.json
 * names its live element; the check renders the part alone in the
 * workspace's dev server and diffs it against the Proto window's page
 * (tools/check.mjs, in-process), then reports pass and matched for the
 * part's node.
 *
 * Usage: node tools/check-part.mjs <briefId> --codebase <id> <part-slug> [--no-send] [--port 9333]
 *
 * Prints one JSON line: { slug, matched, states: [{ state, verdict,
 * mismatch, clusters, tail }], stop, pictures } where pictures is the
 * folder with <n>-live.png (the product), <n>.png (ours) and
 * <n>-diff.png. Every pass is recorded in the build's tail.jsonl
 * (tools/tail.mjs); `tail` says when the unit should stop on a state
 * and why (a small share of the page, passes that no longer help, the
 * budget spent), `stop` when that holds for every differing state.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFolder, nextPassFor } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { ACCEPTED, checkComponent, liveMatchOf } from "./check.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { classifyPart, passTrend, readRecords, record, tailFile, unitBudget } from "./tail.mjs";

const USAGE = "usage: node tools/check-part.mjs <briefId> --codebase <id> <part-slug> [--no-send] [--port 9333]";
const options = { port: "9333" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--no-send") options.noSend = true;
  else if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [briefId, slug] = positional;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!briefId || !slug || !options.codebase) fail(USAGE);

const buildDir = buildFolder(options.codebase, briefId);
const need = (name) => {
  const path = join(buildDir, name);
  if (!existsSync(path)) fail(`${path} does not exist: run proto-build.mjs first`);
  return JSON.parse(readFileSync(path, "utf8"));
};
const workspace = need("workspace.json");
const tree = need("tree.json");
const parts = need("parts.json");
const part = parts.parts.find((p) => p.slug === slug);
if (!part) fail(`no part ${slug} in this build; parts: ${parts.parts.map((p) => p.slug).join(", ")}`);
const folder = join(workspace.path, "src", "parts", slug);
const unitPath = join(folder, "component.json");
if (!existsSync(unitPath)) fail(`${unitPath} does not exist`);
const unit = JSON.parse(readFileSync(unitPath, "utf8"));

// A server another unit or the serve skill started is shared and left up; one started here stays up for the next check.
const dev = await ensureDevServer({ workspace: workspace.path, logPath: join(buildDir, "dev.log"), keep: true });
const out = join(buildDir, "checks", slug);
const outcome = await checkComponent({ unit, slug, appUrl: dev.url, liveMatch: liveMatchOf(tree.url), out, codebase: options.codebase, port: Number(options.port) });

const reporter = createReporter({ codebase: options.codebase, briefId, runDir: buildDir, sink: options.noSend ? "file" : "site" });
reporter.send([{ kind: "focus", id: part.id }]);
// Each pass with its crop (exactly the part's rect) and the red difference picture.
const images = await Promise.all(
  outcome.states.map(async (state) => {
    if (!state.result) return null;
    const [image, diff] = await Promise.all([reporter.upload(readFileSync(state.result.screenshot)), reporter.upload(readFileSync(state.result.diff))]);
    reporter.send([{ kind: "pass", id: part.id, pass: nextPassFor(buildDir, part.id), mismatch: state.result.mismatch, image, diff }]);
    return image;
  }),
);
if (outcome.matched) {
  const [x, y, w, h] = outcome.states[0].result.rect;
  reporter.send([{ kind: "matched", id: part.id, image: images[0], rect: { x, y, w, h } }]);
}
reporter.send([{ kind: "focus", id: null }]);
await reporter.flush();

// The build's tail record: this unit's checks count from its first after the copy's gate.
const tail = tailFile(options.codebase, briefId);
const before = readRecords(tail);
const phaseAt = [...before].reverse().find((r) => r.kind === "phase")?.at ?? 0;
const own = before.filter((r) => r.at >= phaseAt && r.item === slug);
const checks = own.filter((r) => r.kind === "check").length + 1;
const startedAt = own.find((r) => r.kind === "check")?.at ?? Date.now();
record(tail, { kind: "check", item: slug });
const pageArea = (tree.viewport?.width ?? 1) * (tree.viewport?.height ?? 1) * (outcome.states[0]?.result?.display?.dpr ?? 2) ** 2;
const states = outcome.states.map((s) => {
  const verdict = s.result?.verdict ?? s.verdict;
  const mismatch = s.result?.mismatch ?? null;
  record(tail, { kind: "pass", item: slug, state: s.state, verdict, mismatch });
  let stop = { stop: false, reason: null };
  if (verdict && !ACCEPTED.includes(verdict)) {
    const small = classifyPart({ verdict, mismatch, pageArea });
    const trend = passTrend([...own.filter((r) => r.kind === "pass" && r.state === s.state).map((r) => r.mismatch), mismatch]);
    const budget = unitBudget({ checks, startedAt });
    if (small.tail) stop = { stop: true, rule: small.rule, reason: small.reason.replace("its area", "the page") };
    else if (trend.stop) stop = { stop: true, rule: "diminishing", reason: trend.reason };
    else if (budget.stop) stop = { stop: true, rule: "budget", reason: budget.reason };
  }
  if (stop.stop) console.error(`${slug} ${s.state}: stop here, ${stop.reason}`);
  return { state: s.state, verdict, mismatch, clusters: s.result?.clusters?.slice(0, 3) ?? [], error: s.error, tail: stop };
});
const differing = states.filter((s) => s.verdict && !ACCEPTED.includes(s.verdict));
console.log(
  JSON.stringify({
    slug,
    node: part.id,
    matched: outcome.matched,
    states,
    stop: differing.length > 0 && differing.every((s) => s.tail.stop),
    pictures: out,
  }),
);
process.exit(0);
