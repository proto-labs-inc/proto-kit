#!/usr/bin/env node
/**
 * Every view of a prototype loaded and measured, so the agent learns
 * what broke from numbers, not from reading screenshots: each preview
 * state (?state=<id>) and each variant of each set (?v.<component>=<id>)
 * is opened in the headless Chrome (port 9444) and checked for a blank
 * render, console errors and failed requests, the variant set's marker
 * missing from its own view, and marked parts drawn where they cannot
 * be (a child outside its parent, siblings overlapping that do not
 * overlap in the read of the reference page). In the default view the
 * parts the change did not touch are compared with the read: a marker
 * that moved or resized, and pixel clusters outside the changed parts.
 *
 * Usage: node tools/check-states.mjs <workspace> [--changed <marker,marker>] [--brief <id> --codebase <id>] [--no-send]
 *
 * --changed names the markers the change is about (the variant sets'
 * components are added on their own); everything else is expected to
 * still match the copy. With --brief, each changed marker that is a
 * node of the build gets a pass event with its problem count, and a
 * matched event when it has none.
 *
 * Prints one JSON line: { ok, problems, views: [{ view, url, blank,
 * errors, markers, missing, outside, overlap }], copy: { moved, resized,
 * pixels } }.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOfWorkspace, markerRects, nextPassFor } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { diffPngs, THRESHOLD } from "./cdp/diff.mjs";
import { cropPng, decodePng, encodePng } from "./cdp/png.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { framePaths } from "./cdp/live.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { launchedDisplayOr, viewsOf, waitForMarkers } from "./views.mjs";

const USAGE = "usage: node tools/check-states.mjs <workspace> [--changed <marker,marker>] [--brief <id> --codebase <id>] [--no-send]";
const options = {};
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
const step = (line) => console.error(`… ${line}`);

const manifest = JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8"));
const build = buildOfWorkspace(workspace);
const { rects: readRects, nodeIds } = markerRects(build);
const viewport = build?.tree?.viewport ?? { width: 1280, height: 800 };
const display = launchedDisplayOr(viewport);
const changed = new Set([...(options.changed ? options.changed.split(",") : []), ...(manifest.variantSets ?? []).map((set) => set.component)].map((m) => m.trim()).filter(Boolean));
const outDir = build ? join(build.dir, "checks", "after") : join(workspace, ".proto-checks");
mkdirSync(outDir, { recursive: true });

const dev = await ensureDevServer({ workspace, logPath: join(outDir, "dev.log") });
const views = viewsOf(manifest, dev.url);
const copyView = views.some((view) => view.name === "copy") ? "copy" : "default";

/** One view opened, listened to and measured. */
async function checkView(view) {
  const opened = await headlessPage(view.url, { ...viewport, display });
  const { page } = opened;
  const errors = [];
  try {
    await page.send("Runtime.enable");
    await page.send("Log.enable");
    page.on("Runtime.exceptionThrown", (p) => errors.push({ kind: "exception", text: (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text ?? "").split("\n")[0].slice(0, 300) }));
    page.on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error") return;
      const text = p.args.map((a) => a.value ?? a.description ?? "").join(" ").split("\n")[0].slice(0, 300);
      // React's nesting warning is the reference page's own markup (a div
      // in a p), copied as the page has it; the browser draws it the same.
      if (text.startsWith("In HTML,")) return;
      errors.push({ kind: "console", text });
    });
    page.on("Log.entryAdded", (p) => {
      if (p.entry.level !== "error") return;
      errors.push({ kind: p.entry.source, text: `${p.entry.text} ${p.entry.url ?? ""}`.trim().slice(0, 300) });
    });
    // Loaded once more with the listeners on, so an error thrown while the app mounts is heard.
    const loaded = page.once("Page.loadEventFired");
    await page.send("Page.reload");
    await loaded;
    const marks = await waitForMarkers(page);
    const result = { view: view.name, url: view.url, blank: marks === null || marks.text === 0, errors, markers: marks?.marks.length ?? 0, missing: [], outside: [], overlap: [] };
    if (marks === null) return { result, marks: null, page: opened };
    if (view.component && !marks.marks.some((m) => m.id === view.component)) result.missing.push(view.component);
    Object.assign(result, rectSanity(marks.marks));
    return { result, marks, page: opened };
  } catch (error) {
    await opened.close().catch(() => {});
    return { result: { view: view.name, url: view.url, blank: true, errors: [...errors, { kind: "load", text: error.message }], markers: 0, missing: [], outside: [], overlap: [] }, marks: null, page: null };
  }
}

/** Children outside their parents, and siblings that overlap where the read has them apart. */
function rectSanity(marks) {
  const outside = [];
  const overlap = [];
  const visible = (m) => !m.hidden && m.rect[2] > 0 && m.rect[3] > 0;
  const flowing = (m) => m.position !== "absolute" && m.position !== "fixed";
  const inRead = (a, b) => readRects.has(a) && readRects.has(b);
  for (const m of marks) {
    if (m.parent === null || !visible(m) || !flowing(m)) continue;
    const parent = marks[m.parent];
    if (!visible(parent) || parent.overflow !== "visible") continue;
    const by = Math.max(parent.rect[0] - m.rect[0], parent.rect[1] - m.rect[1], m.rect[0] + m.rect[2] - parent.rect[0] - parent.rect[2], m.rect[1] + m.rect[3] - parent.rect[1] - parent.rect[3]);
    if (by <= 2) continue;
    // The read had it outside too (a sticky bar, a banner): the copy's own shape, not a break.
    if (inRead(m.id, parent.id) && !contains(readRects.get(parent.id), readRects.get(m.id))) continue;
    outside.push({ marker: m.id, parent: parent.id, by: Math.round(by) });
  }
  const byParent = new Map();
  for (const m of marks) {
    if (!visible(m) || !flowing(m)) continue;
    const key = m.parent ?? "root";
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(m);
  }
  for (const siblings of byParent.values()) {
    for (let i = 0; i < siblings.length; i++) {
      for (let j = i + 1; j < siblings.length; j++) {
        const a = siblings[i];
        const b = siblings[j];
        const shared = intersection(a.rect, b.rect);
        if (shared <= 1) continue;
        const smaller = Math.min(a.rect[2] * a.rect[3], b.rect[2] * b.rect[3]);
        if (inRead(a.id, b.id)) {
          if (intersection(toArray(readRects.get(a.id)), toArray(readRects.get(b.id))) > 1) continue;
        } else if (shared < 0.25 * smaller) continue;
        overlap.push({ markers: [a.id, b.id], pixels: Math.round(shared) });
      }
    }
  }
  return { outside, overlap };
}
const toArray = (r) => [r.x, r.y, r.w, r.h];
// The read's rects are clipped to the viewport; a measured one is clipped the same way before they are compared.
function clipToViewport([x, y, w, h]) {
  const x0 = Math.max(0, x);
  const y0 = Math.max(0, y);
  return [x0, y0, Math.min(viewport.width, x + w) - x0, Math.min(viewport.height, y + h) - y0];
}
const contains = (outer, inner) => inner.x >= outer.x - 2 && inner.y >= outer.y - 2 && inner.x + inner.w <= outer.x + outer.w + 2 && inner.y + inner.h <= outer.y + outer.h + 2;
function intersection([ax, ay, aw, ah], [bx, by, bw, bh]) {
  const w = Math.min(ax + aw, bx + bw) - Math.max(ax, bx);
  const h = Math.min(ay + ah, by + bh) - Math.max(ay, by);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * The default view against the read: which untouched markers moved or
 * resized, and the pixel clusters outside the changed parts.
 */
async function copyCheck(marks, opened) {
  if (!build || marks === null) return null;
  const changedRects = [...changed].map((m) => readRects.get(m)).filter(Boolean);
  const insideChange = (r) => changedRects.some((c) => contains(c, r));
  const holdsChange = (r) => changedRects.some((c) => contains(r, c));
  const first = new Map();
  for (const m of marks.marks) if (!first.has(m.id)) first.set(m.id, m);
  const moved = [];
  const resized = [];
  const missing = [];
  for (const [marker, read] of readRects) {
    if (changed.has(marker) || insideChange(read)) continue;
    const now = first.get(marker);
    if (!now) {
      missing.push(marker);
      continue;
    }
    const [x, y, w, h] = clipToViewport(now.rect);
    const entry = { marker, read: [read.x, read.y, read.w, read.h], now: [x, y, w, h].map((v) => Math.round(v * 10) / 10), holdsChange: holdsChange(read) };
    if (Math.abs(x - read.x) > 1 || Math.abs(y - read.y) > 1) moved.push(entry);
    else if (Math.abs(w - read.w) > 1 || Math.abs(h - read.h) > 1) resized.push(entry);
  }
  let pixels = null;
  const frame = framePaths(build.codebase);
  if (existsSync(frame.png)) {
    const mine = join(outDir, "default.png");
    const diff = join(outDir, "default-diff.png");
    await stableShot(opened.page, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, mine);
    const result = diffPngs(frame.png, mine, { diffPath: diff, threshold: THRESHOLD, dpr: display.dpr });
    const outsideChange = result.clusters.filter((c) => !changedRects.some((r) => contains(r, { x: c.cssRect[0], y: c.cssRect[1], w: c.cssRect[2], h: c.cssRect[3] })));
    pixels = { mismatch: result.diffPixels, pct: result.pct, outsideChange: outsideChange.slice(0, 8), screenshot: mine, diff };
  }
  return { moved, resized, missing, pixels };
}

// ---- every view, four at a time ----
const results = [];
let copy = null;
let defaultMarks = null;
const queue = [...views];
async function lane() {
  for (let view = queue.shift(); view; view = queue.shift()) {
    const { result, marks, page } = await checkView(view);
    results.push(result);
    const problems = (result.blank ? 1 : 0) + result.errors.length + result.missing.length + result.outside.length + result.overlap.length;
    step(`${view.name}: ${result.blank ? "blank" : `${result.markers} markers`}, ${result.errors.length} errors, ${result.outside.length} outside, ${result.overlap.length} overlapping${problems === 0 ? "" : "  <-"}`);
    if (page) {
      if (view.name === "default") defaultMarks = marks?.marks ?? null;
      if (view.name === copyView) copy = await copyCheck(marks, page).catch((error) => ({ error: error.message }));
      await page.close().catch(() => {});
    }
  }
}
await Promise.all(Array.from({ length: 4 }, lane));
results.sort((a, b) => views.findIndex((v) => v.name === a.view) - views.findIndex((v) => v.name === b.view));

const problems = results.reduce((n, r) => n + (r.blank ? 1 : 0) + r.errors.length + r.missing.length + r.outside.length + r.overlap.length, 0) + (copy?.moved?.length ?? 0) + (copy?.missing?.length ?? 0);

// ---- the site: a pass per changed node, matched when clean ----
if (options.brief && options.codebase && build) {
  const reporter = createReporter({ codebase: options.codebase, briefId: options.brief, runDir: build.dir, sink: options.noSend ? "file" : "site" });
  // The phase line is the tool's to send: the site never sits on the copy's last line while the states are checked.
  reporter.send([{ kind: "phase", phase: "composing", line: `Checked ${results.length} view${results.length === 1 ? "" : "s"} of the prototype: ${problems === 0 ? "every one draws" : `${problems} problem${problems === 1 ? "" : "s"} to fix`}` }]);
  for (const marker of changed) {
    const nodeId = nodeIds.get(marker);
    if (!nodeId) continue;
    const mine = results.filter((r) => r.view === "default" || views.find((v) => v.name === r.view)?.component === marker);
    const problems = mine.reduce((n, r) => n + (r.blank ? 1 : 0) + r.errors.length + r.missing.length + r.outside.filter((o) => o.marker === marker || o.parent === marker).length + r.overlap.filter((o) => o.markers.includes(marker)).length, 0);
    // The pass's picture: the part as the default view now draws it, cut
    // from that view's screenshot at exactly the part's rect.
    const drawn = defaultMarks?.find((m) => m.id === marker) ?? null;
    let image;
    if (drawn && copy?.pixels?.screenshot && drawn.rect[2] > 0 && drawn.rect[3] > 0) {
      const crop = cropPng(decodePng(readFileSync(copy.pixels.screenshot)), { x: Math.round(drawn.rect[0] * display.dpr), y: Math.round(drawn.rect[1] * display.dpr), width: Math.round(drawn.rect[2] * display.dpr), height: Math.round(drawn.rect[3] * display.dpr) });
      image = await reporter.upload(encodePng(crop));
    }
    const pass = { kind: "pass", id: nodeId, pass: nextPassFor(build.dir, nodeId), mismatch: problems };
    if (image) pass.image = image;
    reporter.send([{ kind: "focus", id: nodeId }, pass]);
    if (problems === 0) {
      const matched = { kind: "matched", id: nodeId };
      if (image) {
        matched.image = image;
        matched.rect = { x: Math.round(drawn.rect[0]), y: Math.round(drawn.rect[1]), w: Math.round(drawn.rect[2]), h: Math.round(drawn.rect[3]) };
      }
      reporter.send([matched]);
    }
  }
  reporter.send([{ kind: "focus", id: null }]);
  await reporter.flush();
}

dev.stop();
console.log(JSON.stringify({ ok: problems === 0, problems, seconds: Math.round((Date.now() - started) / 100) / 10, views: results, copy }));
process.exit(0);
