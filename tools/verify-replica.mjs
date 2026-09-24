#!/usr/bin/env node
/**
 * One verification pass of a replica against its live instance, in
 * one call (MAA-163): captures the element from the live tab in the
 * visible Proto window, renders the replica in the kit's headless
 * Chrome at the same viewport, device pixel ratio and clip, diffs the
 * two in node at threshold 8, writes the pass's files, and prints the
 * numbers and clusters to debug from. Nothing it renders appears on
 * screen, and nobody writes a diff page again.
 *
 * Usage: node verify-replica.mjs <replica> <live-tab-url> <rect> [--out <dir>] [--pass <n>] [--port <visible-cdp-port>]
 *   <replica>       an http(s) URL, or a path to the replica page: a path is
 *                   served from its folder on a free port for this call, so
 *                   same-folder assets (fonts) resolve.
 *   <live-tab-url>  a substring of the live tab's URL in the Proto window.
 *   <rect>          x,y,w,h in CSS px of the element in the live viewport
 *                   (from getBoundingClientRect); the same clip is taken
 *                   from the replica, which must render the element at
 *                   those absolute coordinates (docs/cdp-traps.md).
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
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { findPage } from "./cdp/attach.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { diffPngs, THRESHOLD } from "./cdp/diff.mjs";
import { headlessPage } from "./cdp/headless.mjs";

const USAGE = "usage: node verify-replica.mjs <replica-url-or-path> <live-tab-url> <x,y,w,h> [--out <dir>] [--pass <n>] [--port 9333]";
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
const [replicaArg, liveMatch, rectArg] = positional;
const rect = (rectArg ?? "").split(",").map(Number);
if (!replicaArg || !liveMatch || rect.length !== 4 || rect.some((n) => !Number.isFinite(n))) {
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

// The replica side: headless, same metrics, same clip.
const { url, stop } = await serveIfPath(replicaArg);
step(`rendering the replica headlessly at ${width}x${height} @${dpr}x`);
const replica = await headlessPage(url, { width, height, dpr });
try {
  await stableShot(replica.page, probe, files.screenshot, clip);
} finally {
  await replica.close();
  stop();
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

// A path is served over http from its folder for the duration of the
// call: file:// has its own cache and origin rules, and the replica's
// same-folder fonts must resolve the way they will in the library.
async function serveIfPath(replica) {
  if (/^https?:\/\//.test(replica)) return { url: replica, stop: () => {} };
  const file = resolve(replica);
  if (!existsSync(file)) {
    console.error(`${file} does not exist`);
    process.exit(1);
  }
  const root = dirname(file);
  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
  };
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    const target = resolve(root, `.${path}`);
    if (!target.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = readFileSync(target);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/${encodeURIComponent(basename(file))}`,
    // Chrome keeps its connection alive; close() alone would wait on it.
    stop: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}
