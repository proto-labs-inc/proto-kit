#!/usr/bin/env node
/**
 * The variant previews the manifest expects, from real renders: every
 * variant of every set is opened in the headless Chrome, its part
 * (the elements carrying the set's component marker) is cut out with a
 * margin on the colour it sits on, and the picture goes to
 * public/previews/<component>-<variant>.png. The manifest gets each
 * variant's `preview` and `previewBackground`, and a set whose every
 * variant has a picture loses its `status: "building"`.
 *
 * Usage: node tools/previews.mjs <workspace> [--pad 24] [--brief <id> --codebase <id>] [--no-send]
 *
 * With --brief, the set's default variant is reported as matched for
 * the part's node, with its picture, so the site shows the change.
 * Prints one JSON line: { previews: [{ component, variant, file, rect }], missing: [...] }.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOfWorkspace, markerRects } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { evaluate } from "./cdp/cdp.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { backdropOf, launchedDisplayOr, viewsOf, waitForMarkers } from "./views.mjs";

const USAGE = "usage: node tools/previews.mjs <workspace> [--pad 24] [--brief <id> --codebase <id>] [--no-send]";
const options = { pad: "24" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--no-send") options.noSend = true;
  else if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [workspace] = positional;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!workspace || !existsSync(join(workspace, "public", "prototype.json"))) fail(USAGE);
const started = Date.now();
const pad = Number(options.pad);

const manifestPath = join(workspace, "public", "prototype.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const build = buildOfWorkspace(workspace);
const { nodeIds } = markerRects(build);
const viewport = build?.tree?.viewport ?? { width: 1280, height: 800 };
const display = launchedDisplayOr(viewport);
const previewsDir = join(workspace, "public", "previews");
mkdirSync(previewsDir, { recursive: true });
const logDir = build ? build.dir : join(workspace, ".proto-checks");
mkdirSync(logDir, { recursive: true });
const dev = await ensureDevServer({ workspace, logPath: join(logDir, "dev.log") });
const views = viewsOf(manifest, dev.url).filter((view) => view.component);

const reporter = options.brief && options.codebase && build ? createReporter({ codebase: options.codebase, briefId: options.brief, runDir: build.dir, sink: options.noSend ? "file" : "site" }) : null;
const previews = [];
const missing = [];

/** One variant pictured: the union of its marked elements, padded, clipped to the viewport. */
async function picture(view) {
  const opened = await headlessPage(view.url, { ...viewport, display });
  try {
    const marks = await waitForMarkers(opened.page);
    const mine = marks?.marks.filter((m) => m.id === view.component && !m.hidden && m.rect[2] > 0 && m.rect[3] > 0) ?? [];
    if (mine.length === 0) {
      missing.push({ component: view.component, variant: view.variant, why: marks === null ? "the app did not mount" : `nothing marked ${view.component} in this view` });
      return;
    }
    const x0 = Math.min(...mine.map((m) => m.rect[0]));
    const y0 = Math.min(...mine.map((m) => m.rect[1]));
    const x1 = Math.max(...mine.map((m) => m.rect[0] + m.rect[2]));
    const y1 = Math.max(...mine.map((m) => m.rect[1] + m.rect[3]));
    const clip = {
      x: Math.max(0, Math.floor(x0 - pad)),
      y: Math.max(0, Math.floor(y0 - pad)),
      width: Math.min(viewport.width, Math.ceil(x1 + pad)) - Math.max(0, Math.floor(x0 - pad)),
      height: Math.min(viewport.height, Math.ceil(y1 + pad)) - Math.max(0, Math.floor(y0 - pad)),
    };
    const file = `${view.component}-${view.variant}.png`;
    const selector = `[data-proto-id=${JSON.stringify(view.component)}]`;
    const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}, [...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })])`;
    await stableShot(opened.page, probe, join(previewsDir, file), clip);
    const background = await evaluate(opened.page, backdropOf(selector));
    const part = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
    previews.push({ component: view.component, variant: view.variant, file: `previews/${file}`, background, rect: part });
    console.error(`… ${view.component}=${view.variant}: ${part.w}×${part.h} at ${part.x},${part.y}`);
  } finally {
    await opened.close().catch(() => {});
  }
}

const queue = [...views];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let view = queue.shift(); view; view = queue.shift()) {
    await picture(view).catch((error) => missing.push({ component: view.component, variant: view.variant, why: error.message }));
  }
}));

// ---- the manifest ----
const fresh = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const set of fresh.variantSets ?? []) {
  let complete = true;
  for (const variant of set.variants) {
    const made = previews.find((p) => p.component === set.component && p.variant === variant.id);
    if (!made) {
      complete = false;
      continue;
    }
    variant.preview = made.file;
    variant.previewBackground = made.background;
  }
  if (complete) delete set.status;
}
writeFileSync(manifestPath, JSON.stringify(fresh, null, 2) + "\n");

// ---- the site: the part as the prototype now draws it ----
if (reporter) {
  for (const set of fresh.variantSets ?? []) {
    const nodeId = nodeIds.get(set.component);
    const made = previews.find((p) => p.component === set.component && p.variant === set.default);
    if (!nodeId || !made) continue;
    const image = await reporter.upload(readFileSync(join(workspace, "public", made.file)));
    reporter.send([{ kind: "matched", id: nodeId, image, rect: made.rect }]);
  }
  await reporter.flush();
}

dev.stop();
console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 100) / 10, previews, missing }));
process.exit(0);
