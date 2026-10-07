/**
 * The views a prototype has, from its manifest, and the page-side
 * reads the checks share: check-states.mjs loads every view, previews.mjs
 * pictures every variant.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluate } from "./cdp/cdp.mjs";

/**
 * [{ name, url, state, component, variant }]: the default view, one per
 * preview state, one per variant of each set (at the set's showcase
 * state when it names one).
 */
/** The markers a check treats as changed: those named on the command
 *  line, and every region of every variant set (a set that spans the top
 *  bar and a notice changes both). */
export function changedMarkers(manifest, named = []) {
  return new Set([...named, ...(manifest.variantSets ?? []).flatMap((set) => set.regions ?? [set.component])].map((m) => m.trim()).filter(Boolean));
}

export function viewsOf(manifest, appUrl) {
  const views = [{ name: "default", url: `${appUrl}/`, state: null, component: null, variant: null }];
  // The copy: the default state with every set at its baseline, the page
  // as it was copied, so the untouched parts can be compared with the read
  // without the variants' own sizes moving them.
  const baselines = (manifest.variantSets ?? []).filter((set) => set.baseline);
  if (baselines.length > 0) {
    const params = new URLSearchParams();
    for (const set of baselines) params.set(`v.${set.component}`, set.baseline);
    views.push({ name: "copy", url: `${appUrl}/?${params}`, state: null, component: null, variant: null });
  }
  for (const state of manifest.states ?? []) {
    if (state.id === "default") continue;
    views.push({ name: `state:${state.id}`, url: `${appUrl}/?state=${encodeURIComponent(state.id)}`, state: state.id, component: null, variant: null });
  }
  for (const set of manifest.variantSets ?? []) {
    for (const variant of set.variants ?? []) {
      const params = new URLSearchParams();
      params.set(`v.${set.component}`, variant.id);
      if (set.state) params.set("state", set.state);
      views.push({ name: `variant:${set.component}=${variant.id}`, url: `${appUrl}/?${params}`, state: set.state ?? null, component: set.component, variant: variant.id, regions: set.regions ?? [set.component] });
    }
  }
  return views;
}

/**
 * The display the headless Chrome was last launched for, so a check
 * reuses it instead of relaunching; the common Retina display otherwise.
 */
export function launchedDisplayOr(viewport) {
  const path = join(process.env.HOME ?? "", ".proto", "chrome-headless", "display.json");
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {}
  }
  return { dpr: viewport.dpr ?? 2, colorProfile: "display-p3-d65" };
}

const MARKS = `(() => {
  const els = [...document.querySelectorAll('[data-proto-id]')];
  const index = new Map(els.map((e, i) => [e, i]));
  return {
    text: document.body.innerText.trim().length,
    background: getComputedStyle(document.body).backgroundColor,
    marks: els.map((e, i) => {
      const r = e.getBoundingClientRect();
      let p = e.parentElement;
      while (p && !p.hasAttribute('data-proto-id')) p = p.parentElement;
      const cs = getComputedStyle(e);
      return { i, id: e.dataset.protoId, rect: [r.x, r.y, r.width, r.height], parent: p ? index.get(p) : null, overflow: cs.overflow, position: cs.position, hidden: cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0' };
    }),
  };
})()`;

/**
 * Waits for the app to mount (a marked element in the document) and
 * for its fonts, then reads every marked element: { text, background,
 * marks: [{ i, id, rect, parent, overflow, position, hidden }] }, or
 * null when nothing marked appeared within the wait.
 */
export async function waitForMarkers(page, timeoutMs = 10_000) {
  const mounted = await evaluate(
    page,
    `new Promise((done) => { const until = Date.now() + ${timeoutMs}; const tick = () => { if (document.querySelector('[data-proto-id]')) done(true); else if (Date.now() > until) done(false); else setTimeout(tick, 50); }; tick(); })`,
  );
  if (!mounted) return null;
  await evaluate(page, "Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(() => document.fonts.status)");
  // One frame more: a layout effect that sizes something runs after mount.
  await evaluate(page, "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
  return evaluate(page, MARKS);
}

/** The colour behind an element: its own or the first painted ancestor's. */
export const backdropOf = (selector) => `(() => {
  let e = document.querySelector(${JSON.stringify(selector)});
  while (e) { const c = getComputedStyle(e).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') return c; e = e.parentElement; }
  return getComputedStyle(document.body).backgroundColor;
})()`;

/** The box a region draws in, as [x0, y0, x1, y1] in CSS px, or null when
 *  nothing of it shows: the marked element and everything inside it (an
 *  open menu that hangs below a top bar), and its pieces portaled elsewhere
 *  (marked "<marker>-…"), clipped to the viewport. */
export const regionBox = (marker) => `(() => {
  const own = [...document.querySelectorAll('[data-proto-id=' + JSON.stringify(${JSON.stringify(marker)}) + ']')];
  const pieces = [...document.querySelectorAll('[data-proto-id^=' + JSON.stringify(${JSON.stringify(marker)} + "-") + ']')].filter((e) => !own.some((o) => o.contains(e)));
  let box = null;
  for (const top of [...own, ...pieces]) for (const e of [top, ...top.querySelectorAll("*")]) {
    const s = getComputedStyle(e);
    if (s.display === "none" || s.visibility === "hidden") continue;
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    box = box ? [Math.min(box[0], r.left), Math.min(box[1], r.top), Math.max(box[2], r.right), Math.max(box[3], r.bottom)] : [r.left, r.top, r.right, r.bottom];
  }
  if (!box) return null;
  const clipped = [Math.max(0, box[0]), Math.max(0, box[1]), Math.min(innerWidth, box[2]), Math.min(innerHeight, box[3])];
  return clipped[2] > clipped[0] && clipped[3] > clipped[1] ? JSON.stringify(clipped) : null;
})()`;

/** What on the page spills past the viewport's right edge, as a JSON list
 *  of { label, by }: visible elements whose box ends more than a pixel
 *  beyond it. A page that lays out at this width has none. */
export const OVERFLOWING = `(() => {
  const out = [];
  for (const e of document.body.querySelectorAll("*")) {
    const r = e.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.right <= innerWidth + 1) continue;
    const s = getComputedStyle(e);
    if (s.visibility === "hidden" || s.display === "none" || s.position === "fixed") continue;
    const owner = e.closest("[data-proto-id]");
    out.push({ label: (owner ? owner.getAttribute("data-proto-id") : e.tagName.toLowerCase()) + ((e.innerText || "").trim() ? ' "' + e.innerText.trim().replace(/\\s+/g, " ").slice(0, 30) + '"' : ""), by: Math.round(r.right - innerWidth) });
  }
  return JSON.stringify(out);
})()`;

/** The narrowest width, down to `floor`, at which an open page still lays
 *  out without spilling sideways (its own CSS re-flows it), walking down in
 *  `step` px and stopping at the first spill: a page can fit again further
 *  down only because a breakpoint hides a whole bar (Supabase's top bar
 *  below 768 px), which is not the same layout. */
export async function narrowestWidth(page, { width, height, dpr }, { floor = 640, step = 25 } = {}) {
  const fits = async (w) => {
    await page.send("Emulation.setDeviceMetricsOverride", { width: w, height, deviceScaleFactor: dpr, mobile: false });
    await new Promise((r) => setTimeout(r, 200));
    return JSON.parse(await evaluate(page, OVERFLOWING)).length === 0;
  };
  try {
    let narrowest = width;
    for (let w = width - step; w >= floor; w -= step) {
      if (!(await fits(w))) break;
      narrowest = w;
    }
    return narrowest;
  } finally {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: dpr, mobile: false });
  }
}
