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
 * mismatch, clusters }], pictures } where pictures is the folder with
 * <n>-live.png (the product), <n>.png (ours) and <n>-diff.png.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFolder, nextPassFor } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { checkComponent, liveMatchOf } from "./check.mjs";
import { ensureDevServer } from "./dev-server.mjs";

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
for (const state of outcome.states) {
  if (!state.result) continue;
  reporter.send([{ kind: "pass", id: part.id, pass: nextPassFor(buildDir, part.id), mismatch: state.result.mismatch }]);
}
if (outcome.matched) {
  const first = outcome.states[0].result;
  const [x, y, w, h] = first.rect;
  const image = await reporter.upload(readFileSync(first.screenshot));
  reporter.send([{ kind: "matched", id: part.id, image, rect: { x, y, w, h } }]);
}
reporter.send([{ kind: "focus", id: null }]);
await reporter.flush();

console.log(
  JSON.stringify({
    slug,
    node: part.id,
    matched: outcome.matched,
    states: outcome.states.map((s) => ({ state: s.state, verdict: s.result?.verdict ?? s.verdict, mismatch: s.result?.mismatch ?? null, clusters: s.result?.clusters?.slice(0, 3) ?? [], error: s.error })),
    pictures: out,
  }),
);
process.exit(0);
