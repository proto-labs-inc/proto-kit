#!/usr/bin/env node
/**
 * One verification pass of a component against its live instance, in
 * one call (MAA-163): captures the element from the live tab in the
 * visible Proto window, renders the library app's render route for
 * that component and state (`#/render/<slug>/<state>?x&y&w`, the
 * component alone at the instance's absolute coordinates) in the
 * kit's headless Chrome at the same viewport and device pixel ratio,
 * diffs the two clips in node at threshold 8, writes the pass's
 * files, and prints the numbers and clusters to debug from. Nothing
 * it renders appears on screen, and nobody writes a diff page again.
 *
 * Usage: node verify-replica.mjs <app-url> <slug> <state> <live-tab-url> <rect> [--out <dir>] [--pass <n>] [--port <visible-cdp-port>]
 *   <app-url>       the library app's dev server, http://localhost:5210.
 *   <slug> <state>  the component and the name of the state to render,
 *                   from its src/components/<slug>/states.json.
 *   <live-tab-url>  a substring of the live tab's URL in the Proto window.
 *   <rect>          x,y,w,h in CSS px of the element in the live viewport
 *                   (from getBoundingClientRect); the component is placed
 *                   at x,y with width w and the same clip is taken from
 *                   both sides (docs/cdp-traps.md on why position matters).
 *   --out           where the files go (default: the current folder).
 *   --pass          the pass number for the file names (default: next free).
 *
 * Writes <out>/<n>-live.png, <out>/<n>.png (the replica) and
 * <out>/<n>-diff.png, and prints one JSON line:
 *   { pass, mismatch, pct, maxDelta, clusters, screenshot, diff, live,
 *     viewport: [w, h], dpr }
 * The orchestrator lands the pass with:
 *   node tools/library.mjs history <library> <slug> --screenshot <n>.png --diff <n>-diff.png --mismatch <mismatch> --activity "..."
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { findPage } from "./cdp/attach.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { diffPngs, THRESHOLD } from "./cdp/diff.mjs";
import { headlessPage } from "./cdp/headless.mjs";

const USAGE = "usage: node verify-replica.mjs <app-url> <slug> <state> <live-tab-url> <x,y,w,h> [--out <dir>] [--pass <n>] [--port 9333]";
const options = { out: ".", port: "9333" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else {
    positional.push(args[i]);
  }
}
const [appUrl, slug, stateName, liveMatch, rectArg] = positional;
const rect = (rectArg ?? "").split(",").map(Number);
if (!appUrl || !slug || !stateName || !liveMatch || rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) {
  console.error(USAGE);
  process.exit(1);
}
const [x, y, w, h] = rect;
// A pass that stalls (a tab that never commits a frame) must fail
// plainly rather than hang the unit that called it.
setTimeout(() => {
  console.error("verify-replica gave up after 60s: a capture never completed; check the live tab is still open and try again");
  process.exit(2);
}, 60_000).unref();
const out = resolve(options.out);
mkdirSync(out, { recursive: true });
const pass = options.pass ? Number(options.pass) : nextPass(out);
const files = {
  live: join(out, `${pass}-live.png`),
  screenshot: join(out, `${pass}.png`),
  diff: join(out, `${pass}-diff.png`),
};

// The live side: the tab in the visible window, read and captured,
// never navigated. The probe holds viewport and fonts still across
// the capture; a resize mid-capture starts it over.
const tab = await findPage(liveMatch, Number(options.port));
if (!tab) {
  console.error(`no open tab matches "${liveMatch}" on port ${options.port}; the product page must be open in the Proto window`);
  process.exit(1);
}
const step = (message) => console.error(`… ${message}`);
step(`capturing the live element from ${tab.url.slice(0, 80)}`);
const live = await connect(tab.webSocketDebuggerUrl);
const [width, height, dpr] = await evaluate(live, "[innerWidth, innerHeight, devicePixelRatio]");
const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`;
const clip = { x, y, width: w, height: h };
await stableShot(live, probe, files.live, clip);
live.close();

// The replica side: the app's render route, headless, same metrics,
// same clip. The route answers with a sentence instead of the
// component when the state is not there; that is a failed pass.
const url = `${appUrl.replace(/\/+$/, "")}/#/render/${encodeURIComponent(slug)}/${encodeURIComponent(stateName)}?x=${x}&y=${y}&w=${w}`;
step(`rendering ${slug}/${stateName} headlessly at ${width}x${height} @${dpr}x`);
const replica = await headlessPage(url, { width, height, dpr });
try {
  // The route marks its wrapper once it knows the state, and the lazy
  // module's fallback while the module is still loading: wait for the
  // first, then for the second to clear, then for the module's fonts.
  await evaluate(replica.page, "new Promise((done) => { const tick = () => document.querySelector('[data-render]') && !document.querySelector('[data-loading]') ? done() : setTimeout(tick, 50); tick(); })");
  const outcome = await evaluate(replica.page, "document.querySelector('[data-render]').dataset.render");
  if (outcome !== "ok") {
    console.error(`the render route could not show ${slug}/${stateName}: ${outcome}`);
    process.exit(1);
  }
  await evaluate(replica.page, "document.fonts.ready.then(() => document.fonts.status)");
  await stableShot(replica.page, probe, files.screenshot, clip);
} finally {
  await replica.close();
}

step("diffing");
const result = diffPngs(files.live, files.screenshot, { diffPath: files.diff, threshold: THRESHOLD, dpr });
console.log(
  JSON.stringify({
    pass,
    mismatch: result.diffPixels,
    pct: result.pct,
    maxDelta: result.maxDelta,
    clusters: result.clusters,
    screenshot: files.screenshot,
    diff: files.diff,
    live: files.live,
    viewport: [width, height],
    dpr,
  }),
);

function nextPass(dir) {
  let last = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.png$/.exec(name);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return last + 1;
}
