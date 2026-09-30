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
 * a look), "context" (every difference lies in a photo the replica
 * shows too, loaded, differing in under a fifth of its pixels, which
 * each browser scales with its own rasteriser, or under something the
 * page lays over the component), "faint" (a few stray edge pixels, under
 * 0.3% of the component), "offscreen" (the live element is cut off by
 * the viewport, so only its visible part was compared) or "differs".
 * With a codebase, a resting state is cut from the import's one frame
 * of the resting page (tools/cdp/live.mjs); every read of the live page
 * holds the window's lock, so lanes never see each other's held states. `activity` is
 * the verdict in the product's words, ready for the library.
 *
 * tools/check.mjs runs this for every state of a component and lands
 * each pass in the library; units use that, not this, directly.
 */
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findPage } from "./cdp/attach.mjs";
import { stableClip, stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { diffPngs, THRESHOLD } from "./cdp/diff.mjs";
import { displayOf, headlessPage } from "./cdp/headless.mjs";
import { frameCrop, withLive } from "./cdp/live.mjs";
import { decodePng } from "./cdp/png.mjs";

export const FORCEABLE = ["hover", "focus", "active", "focus-visible"];

/**
 * The live element's rect at full precision, whether the viewport
 * cuts it off, and its rounded corners (`corners`: [x, y] radii in CSS
 * px, top-left first, clockwise). `target` is { selector } or
 * { rect: [x, y, w, h] }.
 */
export async function liveRect(live, target) {
  if (target.rect) {
    const [x, y, w, h] = target.rect;
    const [vw, vh] = await evaluate(live, "[innerWidth, innerHeight]");
    return { x, y, w, h, cut: x < 0 || y < 0 || x + w > vw || y + h > vh, corners: [] };
  }
  const found = await evaluate(
    live,
    `(() => {
      const el = document.querySelector(${JSON.stringify(target.selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const px = (part, size) => (part.endsWith('%') ? (parseFloat(part) / 100) * size : parseFloat(part)) || 0;
      const corners = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => { const parts = s.getPropertyValue('border-' + c + '-radius').split(/\s+/); return [px(parts[0], r.width), px(parts[1] ?? parts[0], r.height)]; });
      return [r.x, r.y, r.width, r.height, innerWidth, innerHeight, corners];
    })()`,
  );
  if (!found) throw new Error(`nothing on the live page matches ${target.selector}`);
  const [x, y, w, h, vw, vh, corners] = found;
  return { x, y, w, h, cut: x < 0 || y < 0 || x + w > vw || y + h > vh, corners };
}

/**
 * Which device pixels of a capture lie outside the element's rounded
 * outline: the corners' curves, with the pixel that straddles each
 * curve. There the page shows through (a badge laid over an icon shows
 * the icon at its corners), so those pixels are the page's, not the
 * component's; null when no corner is rounded.
 */
export function outsideCorners(rect, dpr) {
  const corners = rect.corners ?? [];
  if (corners.length !== 4 || corners.every(([x, y]) => x <= 0 || y <= 0)) return null;
  const W = rect.w * dpr;
  const H = rect.h * dpr;
  // CSS scales every radius down together when adjacent ones overlap.
  let f = 1;
  const [tl, tr, br, bl] = corners.map(([x, y]) => [x * dpr, y * dpr]);
  for (const sum of [tl[0] + tr[0], bl[0] + br[0]]) if (sum > W) f = Math.min(f, W / sum);
  for (const sum of [tl[1] + bl[1], tr[1] + br[1]]) if (sum > H) f = Math.min(f, H / sum);
  const arcs = [
    { rx: tl[0] * f, ry: tl[1] * f, cx: tl[0] * f, cy: tl[1] * f, left: true, top: true },
    { rx: tr[0] * f, ry: tr[1] * f, cx: W - tr[0] * f, cy: tr[1] * f, left: false, top: true },
    { rx: br[0] * f, ry: br[1] * f, cx: W - br[0] * f, cy: H - br[1] * f, left: false, top: false },
    { rx: bl[0] * f, ry: bl[1] * f, cx: bl[0] * f, cy: H - bl[1] * f, left: true, top: false },
  ].filter((a) => a.rx > 0 && a.ry > 0);
  return (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    for (const a of arcs) {
      // Only the corner's own square holds a curve.
      if (a.left ? px > a.cx : px < a.cx) continue;
      if (a.top ? py > a.cy : py < a.cy) continue;
      const inner = ((px - a.cx) / Math.max(a.rx - 1, 0.01)) ** 2 + ((py - a.cy) / Math.max(a.ry - 1, 0.01)) ** 2;
      if (inner > 1) return true;
    }
    return false;
  };
}

/**
 * Hold a pseudo-class on the live element while `work` runs, then let
 * it go. The element's transitions are finished outright rather than
 * waited out: the Proto window sits behind other windows, where a
 * transition never advances (nothing paints), so waiting reads its
 * first frame. Finishing jumps each one to its end, on the way in and
 * again on the way out, and leaves the page as it was. No timer waits:
 * the tab is hidden, where Chrome runs a timer a second late at best,
 * and asking for the animations brings the style up to date anyway.
 */
export async function withForcedState(live, selector, pseudo, work) {
  return withLive(() => holding(live, selector, pseudo, work));
}

async function holding(live, selector, pseudo, work) {
  const settle = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; for (const a of el.getAnimations({ subtree: true })) if (a instanceof CSSTransition) a.finish(); return true; })()`;
  // A capture straight after another state's release can catch that
  // state fading out: finish whatever is still running first.
  if (selector) await evaluate(live, settle);
  if (!selector) return work();
  if (!pseudo) return work();
  await live.send("DOM.enable");
  await live.send("CSS.enable");
  const { root } = await live.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await live.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  if (!nodeId) throw new Error(`nothing on the live page matches ${selector}`);
  await live.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [pseudo] });
  try {
    await evaluate(live, settle);
    return await work();
  } finally {
    await live.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    await evaluate(live, settle).catch(() => {});
  }
}

/**
 * What on the live page can make a component differ without being
 * wrong, as boxes inside the component's own box: its photos (scaled
 * by each browser's own rasteriser) and whatever the page lays over it
 * (a floating card, with room for its shadow; a placeholder painted
 * over a field by an element the pointer cannot hit).
 */
export async function liveContext(live, selector, rect) {
  return evaluate(
    live,
    `(${String.raw`(selector, rx, ry, rw, rh) => {
      const el = document.querySelector(selector);
      if (!el) return { images: [], covers: [] };
      const rel = (r, grow = 0) => [r.x - rx - grow, r.y - ry - grow, r.width + 2 * grow, r.height + 2 * grow];
      const images = [...(el.matches('img, video, canvas') ? [el] : []), ...el.querySelectorAll('img, video, canvas')].map((e) => rel(e.getBoundingClientRect()));
      const covers = [];
      const seen = new Set();
      // Whatever paints over the component from outside it: every
      // painting element outside its subtree and ancestry whose box
      // crosses its own and sits above it, by the hit test where both
      // can be hit, else by tree order (later paints over earlier). The
      // hit test alone misses what the pointer cannot reach
      // (pointer-events: none), which is exactly how a page lays text
      // over a field.
      const paints = (e, s) => ['IMG', 'svg', 'VIDEO', 'CANVAS'].includes(e.tagName) || !/rgba\(0, 0, 0, 0\)/.test(s.backgroundColor) || s.backgroundImage !== 'none' || s.boxShadow !== 'none' || (s.borderTopStyle !== 'none' && s.borderTopWidth !== '0px') || [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== '');
      for (const other of document.body.querySelectorAll('*')) {
        if (covers.length >= 40) break;
        if (other === el || el.contains(other) || other.contains(el)) continue;
        const o = other.getBoundingClientRect();
        if (o.width === 0 || o.height === 0 || o.x >= rx + rw || rx >= o.x + o.width || o.y >= ry + rh || ry >= o.y + o.height) continue;
        const s = getComputedStyle(other);
        if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0' || !paints(other, s)) continue;
        const mx = (Math.max(o.x, rx) + Math.min(o.x + o.width, rx + rw)) / 2;
        const my = (Math.max(o.y, ry) + Math.min(o.y + o.height, ry + rh)) / 2;
        const stack = mx >= 0 && my >= 0 && mx < innerWidth && my < innerHeight ? document.elementsFromPoint(mx, my) : [];
        const iOther = stack.findIndex((e) => e === other || other.contains(e));
        const iEl = stack.indexOf(el);
        let above;
        if (iOther !== -1 && iEl !== -1) above = iOther < iEl;
        else above = Boolean(el.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING);
        if (!above) continue;
        seen.add(other);
        covers.push(rel(o, s.boxShadow === 'none' ? 1 : 24));
      }
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
        const x = rx + 1 + (rw - 2) * (i / 6);
        const y = ry + 1 + (rh - 2) * (j / 6);
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (!hit || el.contains(hit) || hit.contains(el)) continue;
        // The box that paints: the nearest ancestor with a fill or a shadow.
        let box = hit;
        for (let up = hit; up && !up.contains(el); up = up.parentElement) {
          const s = getComputedStyle(up);
          if (!/rgba\(0, 0, 0, 0\)/.test(s.backgroundColor) || s.boxShadow !== 'none') { box = up; break; }
        }
        if (seen.has(box)) continue;
        seen.add(box);
        covers.push(rel(box.getBoundingClientRect(), getComputedStyle(box).boxShadow === 'none' ? 1 : 24));
      }
      return { images, covers };
    }`})(${JSON.stringify(selector)}, ${rect.x}, ${rect.y}, ${rect.w}, ${rect.h})`,
  );
}

// Every cluster of differing pixels inside one of the boxes (a pixel of slack).
function within(clusters, boxes) {
  if (clusters.length === 0 || boxes.length === 0) return false;
  return clusters.every(({ cssRect: [cx, cy, cw, ch] }) =>
    boxes.some(([bx, by, bw, bh]) => cx >= bx - 1 && cy >= by - 1 && cx + cw <= bx + bw + 1 && cy + ch <= by + bh + 1),
  );
}

/**
 * How many differing device pixels lie in none of the boxes (CSS px
 * relative to the capture, a pixel of slack). Counted pixel by pixel:
 * a cluster is a bounding box and two overlays side by side merge into
 * one cluster no single box holds.
 */
function outsideBoxes(bad, width, height, boxes, dpr) {
  if (boxes.length === 0) return Infinity;
  const spans = boxes.map(([bx, by, bw, bh]) => [Math.floor((bx - 1) * dpr), Math.floor((by - 1) * dpr), Math.ceil((bx + bw + 1) * dpr), Math.ceil((by + bh + 1) * dpr)]);
  let outside = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!bad[y * width + x]) continue;
      if (!spans.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1)) outside++;
    }
  }
  return outside;
}

// A photo scaled by two browsers' rasterisers differs along its edges
// and in fine detail, never in most of its pixels: beyond a fifth of
// them it is another picture, or none.
const IMAGE_SLACK = 0.2;

/** Differing device pixels inside one box (CSS px, relative to the capture), at the diff's threshold. */
function mismatchIn(live, mine, [bx, by, bw, bh], dpr) {
  const x0 = Math.max(0, Math.floor(bx * dpr));
  const y0 = Math.max(0, Math.floor(by * dpr));
  const x1 = Math.min(live.width, mine.width, Math.ceil((bx + bw) * dpr));
  const y1 = Math.min(live.height, mine.height, Math.ceil((by + bh) * dpr));
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * live.width + x) * 4;
      const j = (y * mine.width + x) * 4;
      const delta = Math.max(Math.abs(live.data[i] - mine.data[j]), Math.abs(live.data[i + 1] - mine.data[j + 1]), Math.abs(live.data[i + 2] - mine.data[j + 2]));
      if (delta > THRESHOLD) count++;
    }
  }
  return count;
}

/**
 * The live page's photos that count as context: all of them when the
 * replica shows as many, every one loaded, and each differs in under
 * IMAGE_SLACK of its pixels; none otherwise (a missing or different
 * picture is the replica's own difference).
 */
function photosAsContext(images, replicaImages, livePath, minePath, dpr) {
  if (images.length === 0 || replicaImages.count !== images.length || !replicaImages.loaded) return [];
  const live = decodePng(readFileSync(livePath));
  const mine = decodePng(readFileSync(minePath));
  const close = images.every((box) => mismatchIn(live, mine, box, dpr) < IMAGE_SLACK * box[2] * box[3] * dpr * dpr);
  return close ? images : [];
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

function activityFor(verdict, clusters, rect, photos) {
  switch (verdict) {
    case "context":
      if (within(clusters, photos)) return "Matches the product; its photo is scaled a little differently by each browser";
      return "Matches the product where the page does not lay something over it";
    case "faint":
      return `Matches the product but for a faint edge ${whereOn(clusters[0], rect.w, rect.h)}`;
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
export async function verifyPass({ appUrl, slug, state, liveMatch, target, force, out, pass, codebase, theme = "light", port = 9333 }) {
  mkdirSync(out, { recursive: true });
  const n = pass ?? nextPass(out);
  const files = { live: join(out, `${n}-live.png`), screenshot: join(out, `${n}.png`), diff: join(out, `${n}-diff.png`) };

  const tab = await findPage(liveMatch, port);
  if (!tab) throw new Error(`no open tab matches "${liveMatch}" on port ${port}; the product page must be open in the Proto window`);
  const live = await connect(tab.webSocketDebuggerUrl);
  let rect;
  let context = { images: [], covers: [] };
  let width;
  let height;
  let display;
  try {
    [width, height] = await evaluate(live, "[innerWidth, innerHeight]");
    display = await displayOf(live);
    const readTarget = async () => {
      rect = await liveRect(live, target);
      if (target.selector) context = await liveContext(live, target.selector, rect);
    };
    const clip = () => ({ x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    // A resting state is cut from the import's one frame of the resting
    // page; a held state, or no frame, captures the live page.
    let fromFrame = false;
    if (!force && target.selector && codebase) {
      await withLive(readTarget);
      fromFrame = await frameCrop(live, codebase, clip(), files.live);
    }
    if (!fromFrame) {
      const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`;
      await withForcedState(live, target.selector, force, async () => {
        await readTarget();
        await stableShot(live, probe, files.live, clip());
      });
    }
  } finally {
    live.close();
  }

  let replicaImages;
  const replicaUrl = new URL(`${appUrl.replace(/\/+$/, "")}/`);
  replicaUrl.searchParams.set("__protoTheme", theme);
  replicaUrl.hash = `/render/${encodeURIComponent(slug)}/${encodeURIComponent(state)}?x=${rect.x}&y=${rect.y}&w=${rect.w}`;
  const replica = await headlessPage(replicaUrl.toString(), { width, height, display });
  try {
    // At most 15 s: a route that never mounts (the app failed to load) is
    // this pass's failure, not a hang. The outcome is read in the same
    // breath as the wait, so a page reloading between the two cannot
    // answer with an empty document.
    const outcome = await evaluate(replica.page, "new Promise((done) => { const until = Date.now() + 15000; const tick = () => { const root = document.querySelector('[data-render]'); if (root && !document.querySelector('[data-loading]')) done(root.dataset.render); else if (Date.now() > until) done(null); else setTimeout(tick, 50); }; tick(); })");
    if (outcome === null) throw new Error(`the render route did not mount ${slug}/${state} within 15 s`);
    if (outcome !== "ok") throw new Error(`the render route could not show ${slug}/${state}: ${outcome}`);
    await evaluate(replica.page, "document.fonts.ready.then(() => document.fonts.status)");
    // The replica's own photos, to tell a photo each browser scales
    // differently from one the replica lacks or never loaded.
    replicaImages = await evaluate(
      replica.page,
      `(() => { const media = [...document.querySelector('[data-render]').querySelectorAll('img, video, canvas')]; return { count: media.length, loaded: media.every((e) => (e.tagName === 'IMG' ? e.complete && e.naturalWidth > 0 : e.tagName !== 'VIDEO' || e.readyState >= 2)) }; })()`,
    );
    const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`;
    // The headless tab is the active one in its own browser, where a
    // clipped capture is safe: only the component's pixels come back, not
    // a whole viewport to decode and cut in node.
    await stableClip(replica.page, probe, files.screenshot, { x: rect.x, y: rect.y, width: rect.w, height: rect.h, scale: 1 });
  } finally {
    await replica.close();
  }

  // Outside the element's rounded corners the page shows through: those pixels are not compared.
  const result = diffPngs(files.live, files.screenshot, { diffPath: files.diff, threshold: THRESHOLD, dpr: display.dpr, ignore: outsideCorners(rect, display.dpr) });
  let verdict = "match";
  let shifted = null;
  let photos = [];
  if (result.diffPixels > 0) {
    shifted = bestShift(files.live, files.screenshot);
    // A move uncovers a one-pixel rim; a residue no bigger than that rim is a placement.
    const rim = Math.round((rect.w + rect.h) * display.dpr);
    // A few stray edge pixels (under 0.3% of the component) are antialiasing
    // the page's own layers decide, not a look the component gets wrong.
    const faint = Math.max(12, Math.round(0.003 * rect.w * rect.h * display.dpr * display.dpr));
    photos = photosAsContext(context.images, replicaImages, files.live, files.screenshot, display.dpr);
    if (shifted.mismatch <= rim && shifted.mismatch < result.diffPixels / 4) verdict = "shifted";
    else if (outsideBoxes(result.bad, result.width, result.height, [...photos, ...context.covers], display.dpr) === 0) verdict = "context";
    else if (result.diffPixels <= faint) verdict = "faint";
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
    activity: activityFor(verdict, result.clusters, rect, photos),
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
  const USAGE = "usage: node verify-replica.mjs <app-url> <slug> <state> <live-tab-url> (--selector <css> | --rect x,y,w,h) [--theme light|dark] [--force hover|focus|active|focus-visible] [--out <dir>] [--pass <n>] [--port 9333]";
  const options = { out: ".", port: "9333", theme: "light" };
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
  if (!["light", "dark"].includes(options.theme)) {
    console.error("--theme is light or dark");
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
      theme: options.theme,
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
