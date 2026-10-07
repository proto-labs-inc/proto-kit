#!/usr/bin/env node
/**
 * The variant previews the manifest expects, from real renders: every
 * variant of every set is opened in the headless Chrome, its part
 * (the elements carrying the set's component marker) is cut out with a
 * margin on the colour it sits on, and the picture goes to
 * public/previews/<component>-<variant>.png. The manifest gets each
 * variant's `preview` and `previewBackground`, and a set whose every
 * variant has a picture loses its `status: "building"`. Each variant is
 * also pictured in every preview state after the first, at
 * <build>/looks/<component>-<variant>--<state>.png (printed as `states`,
 * full paths; never published), for looking at a state without taking
 * screenshots by hand.
 * --only <component>=<variant> pictures that one variant in every state
 * and stops there: no manifest change and nothing sent, so the unit
 * writing a variant can look at its own work while the others write
 * theirs. Its `unstyled` lists the variant's class names no stylesheet
 * defines (they do nothing; a frozen copy compiles no Tailwind), and
 * `layout` the layout faults measured in each state: text over text,
 * text cut off, anything outside the variant's box, marks off a line.
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
import { workflowEvent } from "./workflow-report.mjs";
import { createReporter } from "./build-report.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { decodePng, encodePng } from "./cdp/png.mjs";
import { evaluate } from "./cdp/cdp.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { backdropOf, launchedDisplayOr, regionBox, viewsOf, waitForMarkers } from "./views.mjs";

const USAGE = "usage: node tools/previews.mjs <workspace> [--pad 24] [--only <component>=<variant>] [--brief <id> --codebase <id>] [--no-send]";
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
// --only pictures one variant in every state for the unit writing it, to
// check its own work: the manifest and the site are left to the full run.
const only = options.only ? options.only.split("=") : null;
const views = viewsOf(manifest, dev.url).filter((view) => view.component && (!only || (view.component === only[0] && view.variant === only[1])));
if (only && views.length === 0) fail(`no variant ${options.only} in the manifest`);

const reporter = !only && options.brief && options.codebase && build ? createReporter({ codebase: options.codebase, briefId: options.brief, runDir: build.dir, sink: options.noSend ? "file" : "site" }) : null;
const previews = [];
const missing = [];

/** One variant pictured: the union of its marked elements, padded, clipped to the viewport.
 *  With `state`, the variant in that preview state, kept beside the previews
 *  (public/previews/states/) for the agent to look at; the manifest keeps
 *  the default state's picture. */
async function picture(view, state = null) {
  const opened = await headlessPage(view.url, { ...viewport, display });
  try {
    const marks = await waitForMarkers(opened.page);
    // A set may span several regions (manifest `regions`): each is pictured
    // on its own, and the manifest's preview stacks them, so the card shows
    // the whole variant.
    const regions = view.regions ?? [view.component];
    const multi = regions.length > 1;
    const look = state || only;
    const shots = [];
    for (const [i, region] of regions.entries()) {
      const mine = marks?.marks.filter((m) => m.id === region && !m.hidden && m.rect[2] > 0 && m.rect[3] > 0) ?? [];
      // The region with whatever hangs off it (an open menu), not only its own box.
      const drawn = mine.length ? await evaluate(opened.page, regionBox(region)) : null;
      if (!drawn) {
        missing.push({ component: view.component, variant: view.variant, ...(multi ? { region } : {}), ...(state ? { state } : {}), why: marks === null ? "the app did not mount" : `nothing marked ${region} in this view` });
        continue;
      }
      const [x0, y0, x1, y1] = JSON.parse(drawn);
      const clip = {
        x: Math.max(0, Math.floor(x0 - pad)),
        y: Math.max(0, Math.floor(y0 - pad)),
        width: Math.min(viewport.width, Math.ceil(x1 + pad)) - Math.max(0, Math.floor(x0 - pad)),
        height: Math.min(viewport.height, Math.ceil(y1 + pad)) - Math.max(0, Math.floor(y0 - pad)),
      };
      // Pictures for looking (a state, --only, or one region of several) go
      // to the build folder, never into public/: they are not the
      // prototype's, and publishing refuses odd names.
      const suffix = i === 0 ? "" : `--${region}`;
      const inLooks = look || multi;
      const file = look ? `${view.component}-${view.variant}${suffix}--${state ?? firstState}.png` : `${view.component}-${view.variant}${suffix}.png`;
      const path = join(inLooks ? looksDir : previewsDir, file);
      const selector = `[data-proto-id=${JSON.stringify(region)}]`;
      const probe = `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}, [...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })])`;
      await stableShot(opened.page, probe, path, clip);
      const background = await evaluate(opened.page, backdropOf(selector));
      if (only) {
        const found = unstyledBy.get(region) ?? new Set();
        for (const c of JSON.parse(await evaluate(opened.page, UNSTYLED(selector)))) found.add(c);
        unstyledBy.set(region, found);
        for (const issue of JSON.parse(await evaluate(opened.page, LAYOUT(selector, region)))) layout.push({ state: state ?? firstState, ...(multi ? { region } : {}), issue });
      }
      const rect = { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
      shots.push({ region, path, background, rect });
      if (look) statePictures.push({ component: view.component, variant: view.variant, ...(multi ? { region } : {}), state: state ?? firstState, file: path });
      console.error(`… ${view.component}=${view.variant}${multi ? ` ${region}` : ""}${state ? ` in ${state}` : ""}: ${rect.w}×${rect.h} at ${rect.x},${rect.y}`);
    }
    if (look || shots.length === 0) return;
    if (!multi) {
      const [shot] = shots;
      previews.push({ component: view.component, variant: view.variant, file: `previews/${view.component}-${view.variant}.png`, background: shot.background, rect: shot.rect });
      return;
    }
    const file = `${view.component}-${view.variant}.png`;
    // In page order, top first: the top bar's region above the notice's.
    writeFileSync(join(previewsDir, file), stackPictures([...shots].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x).map((shot) => shot.path)));
    previews.push({ component: view.component, variant: view.variant, file: `previews/${file}`, background: shots[0].background, rect: shots[0].rect, regions: shots.map((shot) => ({ region: shot.region, file: shot.path, rect: shot.rect })) });
  } finally {
    await opened.close().catch(() => {});
  }
}

/** Several region pictures as one: stacked top to bottom, a gap between,
 *  on the colour of the first picture's corner (the page behind it). */
function stackPictures(paths) {
  const images = paths.map((path) => decodePng(readFileSync(path)));
  const gap = Math.round(16 * display.dpr);
  const width = Math.max(...images.map((image) => image.width));
  const height = images.reduce((sum, image) => sum + image.height, 0) + gap * (images.length - 1);
  const data = new Uint8Array(width * height * 4);
  const fill = images[0].data.subarray(0, 4);
  for (let i = 0; i < width * height; i += 1) data.set(fill, i * 4);
  let top = 0;
  for (const image of images) {
    const left = Math.floor((width - image.width) / 2);
    for (let y = 0; y < image.height; y += 1) data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((top + y) * width + left) * 4);
    top += image.height + gap;
  }
  return encodePng({ width, height, data });
}

// Class names on the variant that no stylesheet on the page defines. A
// frozen copy compiles no Tailwind: only the classes the page's own CSS
// has exist, so a utility written fresh (px-[var(--x)] where the page
// has px-(--x)) silently does nothing. Reported under --only so the unit
// fixes it in its own module CSS. Lucide's icon labels (lucide,
// lucide-<name>) are never styles and are left out.
const unstyledBy = new Map();
const frozenPage = join(workspace, "src", "frozen", "page.html");
const pageClasses = new Set(existsSync(frozenPage) ? [...readFileSync(frozenPage, "utf8").matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/)) : []);
const UNSTYLED = (selector) => `(() => {
  const selectors = [];
  const walk = (rules) => { for (const r of rules) { if (r.selectorText) selectors.push(r.selectorText); if (r.cssRules) walk(r.cssRules); } };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch {} }
  const all = selectors.join(" ");
  const classes = new Set();
  for (const root of document.querySelectorAll(${JSON.stringify(selector)})) for (const e of [root, ...root.querySelectorAll("*")]) for (const c of e.classList) classes.add(c);
  return JSON.stringify([...classes].filter((c) => !all.includes("." + CSS.escape(c))));
})()`;

// Layout faults inside the variant, measured from the render so the unit
// does not have to spot them in a picture: text over text, text cut off
// by its box, anything outside the variant's own box, and small marks
// (dots, icons, a thin line) that nearly share a line but miss it by a
// few pixels. Names each by its nearest data-proto-id and its text.
// Whether the design makes sense stays with the picture.
const layout = [];
const LAYOUT = (selector, region) => `(() => {
  // The region's elements, and its pieces portaled elsewhere (a menu named
  // "<region>-…" rendered into <body>), which are checked against the page.
  const inRegion = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((r) => r.getClientRects().length);
  const portaled = [...document.querySelectorAll('[data-proto-id^=' + JSON.stringify(${JSON.stringify(region)} + "-") + ']')].filter((e) => e.getClientRects().length && !inRegion.some((r) => r.contains(e)) && !e.parentElement.closest('[data-proto-id^=' + JSON.stringify(${JSON.stringify(region)} + "-") + ']'));
  const roots = [...inRegion, ...portaled];
  const page = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  // A menu or popover (fixed or absolute inside the region) is meant to
  // leave the region's box; it only has to stay on the page.
  const overlayOf = (e, root) => { for (let a = e; a && a !== root; a = a.parentElement) { const p = getComputedStyle(a).position; if (p === "fixed" || p === "absolute") return a; } return null; };
  const issues = [];
  const visible = (e) => { const s = getComputedStyle(e); return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05; };
  const label = (e) => { const owner = e.closest("[data-proto-id]"); const text = (e.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 30); return (owner ? owner.getAttribute("data-proto-id") : e.tagName.toLowerCase()) + (text ? ' "' + text + '"' : ""); };
  const px = (n) => Math.round(n);
  for (const root of roots) {
    const box = portaled.includes(root) ? page : root.getBoundingClientRect();
    const all = [root, ...root.querySelectorAll("*")].filter((e) => e.getClientRects().length && visible(e));
    // Text over text: each text run's boxes against every other run's.
    const runs = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !visible(n.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      runs.push({ el: n.parentElement, rects: [...range.getClientRects()].filter((r) => r.width > 1 && r.height > 1) });
    }
    for (let i = 0; i < runs.length; i += 1) for (let j = i + 1; j < runs.length; j += 1) {
      if (runs[i].el === runs[j].el) continue;
      let worst = null;
      for (const a of runs[i].rects) for (const b of runs[j].rects) {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 2 && h > 3 && (!worst || w * h > worst.w * worst.h)) worst = { w, h };
      }
      if (worst) issues.push("text overlaps: " + label(runs[i].el) + " and " + label(runs[j].el) + " by " + px(worst.w) + "x" + px(worst.h) + "px");
    }
    for (const e of all) {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      // Cut off: content larger than a box that hides overflow.
      const hides = /hidden|clip/.test(s.overflowX + s.overflowY);
      if (hides && e.textContent.trim() && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 3)) {
        issues.push("text cut off: " + label(e) + (s.textOverflow === "ellipsis" ? " (truncated with an ellipsis)" : "") + ", content " + e.scrollWidth + "x" + e.scrollHeight + " in a " + e.clientWidth + "x" + e.clientHeight + " box");
      }
      // Outside the variant's box; a menu or popover, outside the page.
      if (e !== root && r.width > 0 && r.height > 0) {
        const overlay = box === page ? null : overlayOf(e, root);
        const bounds = overlay || box === page ? page : box;
        const out = Math.max(bounds.left - r.left, r.right - bounds.right, bounds.top - r.top, r.bottom - bounds.bottom);
        if (out > 1.5) issues.push((bounds === page ? "off the page: " : "outside the variant: ") + label(e) + " by " + px(out) + "px");
      }
    }
    // Near misses: small marks and thin lines whose centres sit within 10px
    // of each other vertically but not within 2px.
    const marks = all.filter((e) => { const r = e.getBoundingClientRect(); return (r.width <= 32 && r.height <= 32 && r.width >= 3 && r.height >= 3 && !e.querySelector("*:not(path):not(circle):not(rect):not(line):not(polyline):not(polygon)")) || (r.height <= 4 && r.width >= 24); })
      .filter((e) => !e.closest("svg") || e.tagName.toLowerCase() === "svg")
      .map((e) => { const r = e.getBoundingClientRect(); return { e, cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
    const reported = new Set();
    for (let i = 0; i < marks.length; i += 1) for (let j = i + 1; j < marks.length; j += 1) {
      const a = marks[i], b = marks[j];
      const dy = Math.abs(a.cy - b.cy);
      if (dy > 2 && dy <= 10 && Math.abs(a.cx - b.cx) > 24 && a.e.parentElement !== b.e.parentElement) {
        const key = label(a.e) + "|" + label(b.e);
        if (!reported.has(key)) { reported.add(key); issues.push("off the line: " + label(a.e) + " and " + label(b.e) + " centres " + px(dy) + "px apart vertically"); }
      }
    }
  }
  return JSON.stringify([...new Set(issues)].slice(0, 20));
})()`;

// Every variant in every preview state other than the first (the default),
// so a state's look is checked from a picture, not an improvised screenshot.
const statePictures = [];
const firstState = (manifest.states ?? [])[0]?.id ?? "default";
const otherStates = (manifest.states ?? []).slice(1).map((st) => st.id);
const looksDir = join(logDir, "looks");
mkdirSync(looksDir, { recursive: true });
const jobs = [
  ...views.map((view) => [view, null]),
  ...otherStates.flatMap((state) => views.map((view) => [{ ...view, url: `${view.url}${view.url.includes("?") ? "&" : "?"}state=${encodeURIComponent(state)}` }, state])),
];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let job = jobs.shift(); job; job = jobs.shift()) {
    const [view, state] = job;
    await picture(view, state).catch((error) => missing.push({ component: view.component, variant: view.variant, state, why: error.message }));
  }
}));

/** A set of one region lists its classes; one of several, per region. */
function unstyledReport() {
  const keep = (found) => [...found].filter((c) => !pageClasses.has(c) && !/^lucide(-|$)/.test(c));
  if (unstyledBy.size <= 1) return keep(unstyledBy.values().next().value ?? []);
  return Object.fromEntries([...unstyledBy].map(([region, found]) => [region, keep(found)]));
}

if (only) {
  dev.stop();
  console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 100) / 10, only: options.only, pictures: statePictures.map((p) => ({ state: p.state, ...(p.region ? { region: p.region } : {}), file: p.file })), unstyled: unstyledReport(), layout, missing }));
  process.exit(0);
}

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
  reporter.send([workflowEvent(build.dir, "build", `Pictured ${previews.length} variant${previews.length === 1 ? "" : "s"} of ${(fresh.variantSets ?? []).length} set${(fresh.variantSets ?? []).length === 1 ? "" : "s"}`)]);
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
console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 100) / 10, previews, states: statePictures, missing }));
process.exit(0);
