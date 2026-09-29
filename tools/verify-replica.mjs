#!/usr/bin/env node
/**
 * One verification pass of a component state against its live
 * instance, in one call (MAA-163): captures the element from the live
 * tab in the visible Proto window, renders the library app's render
 * route for that component and state (`#/render/<slug>/<state>?x&y&w`,
 * the component alone at the instance's absolute coordinates, on its
 * backdrop) in the kit's headless Chrome launched for the same display
 * (device scale factor and colour profile, tools/cdp/headless.mjs),
 * diffs the two clips in node at threshold 8, and says what the
 * difference is.
 *
 * The live element is named by a selector, never by a typed rect: the
 * rect is read from the page at full precision (a rect rounded to two
 * places moves every edge a fraction of a pixel). A state the product
 * reaches with the pointer or focus is captured with that pseudo-class
 * forced on the live element (CSS.forcePseudoState) and released
 * straight after; nothing is clicked, focused or navigated.
 *
 * Usage: node verify-replica.mjs <app-url> <slug> <state> <live-tab-url> (--selector <css> | --rect x,y,w,h) [--force hover|focus|active|focus-visible] [--out <dir>] [--pass <n>] [--port 9333]
 *
 * Writes <out>/<n>-live.png, <out>/<n>.png (the replica) and
 * <out>/<n>-diff.png and prints one JSON line:
 *   { pass, verdict, mismatch, shifted, maxDelta, clusters, activity,
 *     rect, screenshot, diff, live, viewport, display }
 * verdict is "match" (no pixel differs), "shifted" (every difference
 * goes away with the replica moved one device pixel: a placement, not
 * a look), "offscreen" (the live element is cut off by the viewport,
 * so only its visible part was compared) or "differs". `activity` is
 * the verdict in the product's words, ready for the library.
 *
 * tools/check.mjs runs this for every state of a component and lands
 * each pass in the library; units use that, not this, directly.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPage } from "./cdp/attach.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { diffPngs, THRESHOLD } from "./cdp/diff.mjs";
import { displayOf, headlessPage } from "./cdp/headless.mjs";
import { decodePng } from "./cdp/png.mjs";

export const FORCEABLE = ["hover", "focus", "active", "focus-visible"];

/**
 * The live element's rect at full precision, and whether the viewport
 * cuts it off. `target` is { selector } or { rect: [x, y, w, h] }.
 */
export async function liveRect(live, target) {
  if (target.rect) {
    const [x, y, w, h] = target.rect;
    const [vw, vh] = await evaluate(live, "[innerWidth, innerHeight]");
    return { x, y, w, h, cut: x < 0 || y < 0 || x + w > vw || y + h > vh };
  }
  const found = await evaluate(
    live,
    `(() => { const el = document.querySelector(${JSON.stringify(target.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, innerWidth, innerHeight]; })()`,
  );
  if (!found) throw new Error(`nothing on the live page matches ${target.selector}`);
  const [x, y, w, h, vw, vh] = found;
  return { x, y, w, h, cut: x < 0 || y < 0 || x + w > vw || y + h > vh };
}

/**
 * Hold a pseudo-class on the live element while `work` runs, then let
 * it go. The element's transitions are finished outright rather than
 * waited out: the Proto window sits behind other windows, where a
 * transition never advances (nothing paints), so waiting reads its
 * first frame. Finishing jumps each one to its end, on the way in and
 * again on the way out, and leaves the page as it was.
 */
export async function withForcedState(live, selector, pseudo, work) {
  const settle = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; for (const a of el.getAnimations({ subtree: true })) if (a instanceof CSSTransition) a.finish(); return true; })()`;
  // A capture straight after another state's release can catch that
  // state fading out: finish whatever is still running first.
  if (selector) await evaluate(live, settle);
  if (!pseudo) return work();
  await live.send("DOM.enable");
  await live.send("CSS.enable");
  const { root } = await live.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await live.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`nothing on the live page matches ${selector}`);
  await live.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [pseudo] });
  try {
    await evaluate(live, "new Promise((r) => setTimeout(r, 30))");
    await evaluate(live, settle);
    return await work();
  } finally {
    await live.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    await evaluate(live, "new Promise((r) => setTimeout(r, 30))").catch(() => {});
    await evaluate(live, settle).catch(() => {});
  }
}

/** Differing device pixels with the replica moved by (dx, dy), at the diff's threshold. */
function shiftedMismatch(live, mine, dx, dy) {
  let count = 0;
  for (let y = 0; y < live.height; y++) {
    const sy = y - dy;
    for (let x = 0; x < live.width; x++) {
      const sx = x - dx;
      const i = (y * live.width + x) * 4;
      if (sx < 0 || sy < 0 || sx >= mine.width || sy >= mine.height) continue;
      const j = (sy * mine.width + sx) * 4;
      const delta = Math.max(Math.abs(live.data[i] - mine.data[j]), Math.abs(live.data[i + 1] - mine.data[j + 1]), Math.abs(live.data[i + 2] - mine.data[j + 2]));
      if (delta > THRESHOLD) count++;
    }
  }
  return count;
}

/** The fewest differing pixels over one-device-pixel moves, ignoring the one-pixel rim a move uncovers. */
function bestShift(livePath, minePath) {
  const live = decodePng(readFileSync(livePath));
  const mine = decodePng(readFileSync(minePath));
  let best = { dx: 0, dy: 0, mismatch: Infinity };
  for (const dx of [-1, 0, 1]) {
    for (const dy of [-1, 0, 1]) {
      if (dx === 0 && dy === 0) continue;
      const mismatch = shiftedMismatch(live, mine, dx, dy);
      if (mismatch < best.mismatch) best = { dx, dy, mismatch };
    }
  }
  return best;
}

// Where on the component a cluster sits, in words the product's owner reads.
function whereOn(cluster, w, h) {
  const [cx, cy, cw, ch] = cluster.cssRect;
  if (cw >= w * 0.8 && ch >= h * 0.8) return "across the whole component";
  const across = third(cx + cw / 2, w, ["left", "", "right"]);
  const down = third(cy + ch / 2, h, ["top", "", "bottom"]);
  if (across === "" && down === "") return "in the middle";
  return `at the ${[down, across].filter(Boolean).join(" ")}`;
}

// Which third of `size` the point falls in, named by `names`.
function third(point, size, names) {
  if (point < size / 3) return names[0];
  if (point > (2 * size) / 3) return names[2];
  return names[1];
}

function activityFor(verdict, clusters, rect) {
  switch (verdict) {
    case "match":
      return "Matches the product";
    case "shifted":
      return "Matches the product, one screen pixel over";
    case "offscreen":
      return "Matches where the product shows it; the rest is off the page";
    case "differs":
      if (clusters.length === 0) return "Differs faintly";
      return `Differs ${whereOn(clusters[0], rect.w, rect.h)}`;
  }
}

/**
 * One pass. `target` is { selector } or { rect }. Returns the result
 * object the CLI prints.
 */
export async function verifyPass({ appUrl, slug, state, liveMatch, target, force, out, pass, port = 9333 }) {
  mkdirSync(out, { recursive: true });
  const n = pass ?? nextPass(out);
  const files = { live: join(out, `${n}-live.png`), screenshot: join(out, `${n}.png`), diff: join(out, `${n}-diff.png`) };

  const tab = await findPage(liveMatch, port);
  if (!tab) throw new Error(`no open tab matches "${liveMatch}" on port ${port}; the product page must be open in the Proto window`);
  const live = await connect(tab.webSocketDebuggerUrl);
  let rect;
  let width;
  let height;
  let display;
  try {
    [width, height] = await evaluate(live, "[innerWidth, innerHeight]");
    display = await displayOf(live);
    rect = await liveRect(live, target);
    const clip = { x: rect.x, y: rect.y, width: rect.w, height: rect.h };
    const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`;
    await withForcedState(live, target.selector, force, () => stableShot(live, probe, files.live, clip));
  } finally {
    live.close();
  }

  const url = `${appUrl.replace(/\/+$/, "")}/#/render/${encodeURIComponent(slug)}/${encodeURIComponent(state)}?x=${rect.x}&y=${rect.y}&w=${rect.w}`;
  const replica = await headlessPage(url, { width, height, display });
  try {
    await evaluate(replica.page, "new Promise((done) => { const tick = () => document.querySelector('[data-render]') && !document.querySelector('[data-loading]') ? done() : setTimeout(tick, 50); tick(); })");
    const outcome = await evaluate(replica.page, "document.querySelector('[data-render]').dataset.render");
    if (outcome !== "ok") throw new Error(`the render route could not show ${slug}/${state}: ${outcome}`);
    await evaluate(replica.page, "document.fonts.ready.then(() => document.fonts.status)");
    const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`;
    await stableShot(replica.page, probe, files.screenshot, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
  } finally {
    await replica.close();
  }

  const result = diffPngs(files.live, files.screenshot, { diffPath: files.diff, threshold: THRESHOLD, dpr: display.dpr });
  let verdict = "match";
  let shifted = null;
  if (result.diffPixels > 0) {
    shifted = bestShift(files.live, files.screenshot);
    // A move uncovers a one-pixel rim; a residue no bigger than that rim is a placement.
    const rim = Math.round((rect.w + rect.h) * display.dpr);
    if (shifted.mismatch <= rim && shifted.mismatch < result.diffPixels / 4) verdict = "shifted";
    else verdict = "differs";
  }
  if (rect.cut && verdict !== "differs") verdict = "offscreen";
  return {
    pass: n,
    verdict,
    mismatch: result.diffPixels,
    shifted,
    maxDelta: result.maxDelta,
    clusters: result.clusters,
    activity: activityFor(verdict, result.clusters, rect),
    rect: [rect.x, rect.y, rect.w, rect.h],
    ...files,
    viewport: [width, height],
    display,
  };
}

export function nextPass(dir) {
  let last = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.png$/.exec(name);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return last + 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const USAGE = "usage: node verify-replica.mjs <app-url> <slug> <state> <live-tab-url> (--selector <css> | --rect x,y,w,h) [--force hover|focus|active|focus-visible] [--out <dir>] [--pass <n>] [--port 9333]";
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
  const [appUrl, slug, state, liveMatch, legacyRect] = positional;
  const rectArg = options.rect ?? legacyRect;
  let target = null;
  if (options.selector) target = { selector: options.selector };
  else if (rectArg) target = { rect: rectArg.split(",").map(Number) };
  if (!appUrl || !slug || !state || !liveMatch || !target || (target.rect && (target.rect.length !== 4 || target.rect.some((v) => !Number.isFinite(v))))) {
    console.error(USAGE);
    process.exit(1);
  }
  if (options.force && !FORCEABLE.includes(options.force)) {
    console.error(`--force is one of ${FORCEABLE.join(", ")}`);
    process.exit(1);
  }
  if (options.force && !options.selector) {
    console.error("--force needs --selector: the pseudo-class is held on the live element itself");
    process.exit(1);
  }
  setTimeout(() => {
    console.error("verify-replica gave up after 60s: a capture never completed; check the live tab is still open and try again");
    process.exit(2);
  }, 60_000).unref();
  try {
    const result = await verifyPass({
      appUrl,
      slug,
      state,
      liveMatch,
      target,
      force: options.force,
      out: resolve(options.out),
      pass: options.pass ? Number(options.pass) : undefined,
      port: Number(options.port),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
