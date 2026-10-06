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
