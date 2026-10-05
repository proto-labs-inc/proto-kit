#!/usr/bin/env node
/**
 * Say why a component differs from the product, in concrete terms, so
 * a unit fixes the named value instead of guessing: for every state
 * that still differs, one fresh pass (tools/verify-replica.mjs), then
 * the live element's subtree and our copy's subtree read side by side
 * (the live page through the window's lock, the copy headless) and
 * compared element by element: computed style, boxes, attributes,
 * text, the colour behind the component, references that point at
 * nothing (url(#id), href="#id"), images that did not load, the face
 * each text was actually drawn in. Differences inside the pass's
 * differing clusters come first.
 *
 * Usage: node tools/explain-diff.mjs <codebase> <slug> [--state <name>] [--theme <light|dark>]
 *        node tools/explain-diff.mjs <codebase> <slug> --build <briefId> [--state <name>]
 *
 * The first form explains a library component (src/components/<slug>/
 * in ~/.proto/<codebase>/library, rendered by the library app at its
 * tunnel port); the second a part of a prototype build
 * (<workspace>/src/parts/<slug>/, rendered by the workspace's dev
 * server, against the page the build read). Nothing is landed and
 * nothing is written outside <run>/explain/<slug>/.
 *
 * Prints a few plain lines per state on stderr and one JSON line on
 * stdout: { slug, states: [{ state, verdict, mismatch, clusters,
 * backdrop, blame, differences: [{ kind, element, property, product,
 * here, inCluster, note }] }] } where kind is one of reference, image,
 * font, structure, text, attribute, box, backdrop, style. `blame` says
 * whose the difference is (tools/tail.mjs rule 3): "item" when a value
 * of the component's own differs, "outside" when it lies on something
 * around it (the colour behind it changed, its live element is gone or
 * is another element now, it is animating, it points at something the
 * page defines elsewhere), with the reason; a unit stops on "outside"
 * with that reason instead of fixing.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFolder } from "./build-folder.mjs";
import { keepFolder } from "./unit-restore.mjs";
import { findPage } from "./cdp/attach.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { displayOf, headlessPage } from "./cdp/headless.mjs";
import { ACCEPTED, liveMatchOf } from "./check.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { DECLARED_SET, INHERITED, localRefsIn, skipped } from "./snapshot.mjs";
import { verifyPass, withForcedState } from "./verify-replica.mjs";
import { decodePng } from "./cdp/png.mjs";
import { channelDelta, colourShift, rgbText } from "./colour-shift.mjs";
import { resolveStates } from "./live-selector.mjs";

const USAGE = "usage: node tools/explain-diff.mjs <codebase> <slug> [--state <name>] [--theme <light|dark>] [--build <briefId>]";

// Properties whose value is a colour: compared as the display draws
// them, so "oklch(0.1 0 34)" and the token it resolved to are equal.
const COLOUR_PROPS = new Set([
  "color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "outline-color", "fill", "stroke", "text-decoration-color", "caret-color", "column-rule-color", "accent-color",
  "text-emphasis-color", "-webkit-text-fill-color", "-webkit-text-stroke-color",
]);

// Attributes that may point at another element by id.
const REF_ATTRS = ["fill", "stroke", "href", "xlink:href", "clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end", "aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"];
// Style properties that may point at another element by id.
const REF_PROPS = ["fill", "stroke", "clip-path", "mask", "mask-image", "filter", "marker-start", "marker-mid", "marker-end", "background-image"];

// Attributes never compared: the copy's own wiring (classes, ids, data
// hooks, handlers) means nothing to the look.
const OWN_ATTRS = /^(class|id|style|data-|on|tabindex$|role$|aria-)/;

// Attributes that never change a pixel: where a form goes, what a
// field is called, a tooltip, autofill hints. A value attribute paints
// only through the element's value, compared as text on its own.
const INERT_ATTRS = new Set([
  "action", "method", "enctype", "novalidate", "accept-charset", "target", "rel", "name", "value", "form", "formaction", "formmethod",
  "autocomplete", "autocapitalize", "autocorrect", "autofocus", "spellcheck", "inputmode", "enterkeyhint", "maxlength", "minlength",
  "pattern", "title", "for", "download", "referrerpolicy", "crossorigin", "loading", "decoding", "fetchpriority", "nonce", "translate",
]);
// Attributes whose bare presence paints (an empty value is still "on").
const PRESENCE_ATTRS = new Set(["hidden", "disabled", "checked", "selected", "open", "multiple", "required", "controls", "inert", "contenteditable"]);
// What lays the root out among its neighbours and nothing more: alone on
// the render route, with its size already the product's, a different
// value of one of these changes none of its own pixels, and writing the
// product's (a margin, a display the product's flex parent forced)
// moves or stretches it instead.
const ROOT_LAYOUT = /^(margin-|display$|float$|clear$|flex(-|$)|align-self$|justify-self$|place-self$|order$|grid-(area|column|row)(-|$)|vertical-align$)/;
// A display the parent decides: a flex or grid item is blockified, so
// the product's computed value says where it sits, not what it is.
const BLOCKIFIED = { "inline-block": "block", inline: "block", "inline-flex": "flex", "inline-grid": "grid", "inline-table": "table" };
const blockified = (a, b) => BLOCKIFIED[a] === b || BLOCKIFIED[b] === a;

/** How many differences the plain lines show per state; the JSON holds every one found. */
const SHOWN = 14;

// ---- reading one subtree, on either side ----

/**
 * Everything about the elements under `root` that the comparison
 * needs, in one evaluate: run in the live page for the product's
 * instance and in the headless page for our copy. Rects are relative
 * to the root; colours come back as the display's pixels too.
 */
const READ_SUBTREE = String.raw`(rootSelector, colourProps, refAttrs, refProps, space) => {
  const root = document.querySelector(rootSelector);
  if (!root) return null;
  const rootRect = root.getBoundingClientRect();
  const elements = [root, ...root.querySelectorAll('*')];
  const index = new Map(elements.map((el, i) => [el, i]));
  const canvas = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
  const pixels = (value) => {
    canvas.clearRect(0, 0, 1, 1);
    canvas.fillStyle = '#00000000';
    canvas.fillStyle = value;
    canvas.fillRect(0, 0, 1, 1);
    return [...canvas.getImageData(0, 0, 1, 1).data];
  };
  // The pixels a colour draws as in the capture's own space (sRGB, or
  // Display P3 on a wide-gamut window): what a picture of it should show.
  const drawCanvas = document.createElement('canvas').getContext('2d', { colorSpace: space === 'display-p3-d65' ? 'display-p3' : 'srgb' });
  const drawnAs = (value) => {
    drawCanvas.clearRect(0, 0, 1, 1);
    drawCanvas.fillStyle = '#00000000';
    drawCanvas.fillStyle = value;
    drawCanvas.fillRect(0, 0, 1, 1);
    return [...drawCanvas.getImageData(0, 0, 1, 1).data];
  };
  // A bare "#id" is a reference only where a link goes (href); anywhere else it is a colour.
  const idsIn = (value, name) => {
    const ids = [];
    if (typeof value !== 'string') return ids;
    for (const m of value.matchAll(/url\(\s*["']?#([^"')\s]+)["']?\s*\)/g)) ids.push(m[1]);
    if (/href$/.test(name) && /^#[^\s]+$/.test(value.trim())) ids.push(value.trim().slice(1));
    return ids;
  };
  const styleOf = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo);
    const out = {};
    for (let i = 0; i < s.length; i++) {
      const name = s[i];
      if (name.startsWith('--')) continue;
      out[name] = s.getPropertyValue(name);
    }
    return out;
  };
  const nodes = elements.map((el, i) => {
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    if (el.tagName === 'IMG' && el.currentSrc) attrs.src = el.currentSrc;
    const style = styleOf(el);
    const colours = {};
    const drawn = {};
    for (const name of colourProps) if (style[name] !== undefined) { colours[name] = pixels(style[name]); drawn[name] = drawnAs(style[name]); }
    const pseudo = {};
    for (const which of ['::before', '::after']) {
      const s = getComputedStyle(el, which);
      if (s.content && s.content !== 'none' && s.content !== 'normal') pseudo[which] = styleOf(el, which);
    }
    // References this element makes by id, and whether each resolves on this page.
    const references = [];
    for (const name of refAttrs) for (const id of idsIn(attrs[name], name)) references.push({ where: 'attribute', name, id, found: document.getElementById(id) !== null });
    for (const name of refProps) for (const id of idsIn(style[name], name)) references.push({ where: 'style', name, id, found: document.getElementById(id) !== null });
    // Aria lists name several ids at once.
    for (const name of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns']) {
      if (!attrs[name]) continue;
      for (const id of attrs[name].split(/\s+/).filter(Boolean)) references.push({ where: 'attribute', name, id, found: document.getElementById(id) !== null });
    }
    let text = '';
    for (const child of el.childNodes) if (child.nodeType === 3) text += child.textContent;
    const r = el.getBoundingClientRect();
    let image = null;
    if (el.tagName === 'IMG') image = { src: el.currentSrc || el.getAttribute('src') || '', loaded: el.complete && el.naturalWidth > 0 };
    return {
      i, tag: el.localName, svg: el.namespaceURI === 'http://www.w3.org/2000/svg',
      parent: i === 0 ? -1 : index.get(el.parentElement) ?? -1,
      attrs, text, style, colours, drawn, pseudo, references, image,
      value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? el.value : null,
      rect: [r.x - rootRect.x, r.y - rootRect.y, r.width, r.height],
    };
  });
  // The colour behind the root: its painted ancestors composited, as the snapshot computes it.
  const layers = [];
  for (let el = root.parentElement; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    layers.push(bg);
    if (pixels(bg)[3] === 255) break;
  }
  layers.reverse();
  const visible = layers.filter((c) => pixels(c)[3] > 0);
  const behind = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
  for (const layer of visible) { behind.fillStyle = layer; behind.fillRect(0, 0, 1, 1); }
  const backdrop = visible.length === 0 ? null : [...behind.getImageData(0, 0, 1, 1).data];
  // What changes every pixel without a value of the component's own:
  // an opacity, a filter or a blend on it or on anything around it.
  const effects = [];
  for (let el = root; el && el.nodeType === 1; el = el.parentElement) {
    const s = getComputedStyle(el);
    const own = [];
    if (parseFloat(s.opacity) < 1) own.push('opacity ' + s.opacity);
    if (s.filter && s.filter !== 'none') own.push('filter ' + s.filter);
    if (s.mixBlendMode && s.mixBlendMode !== 'normal') own.push('mix-blend-mode ' + s.mixBlendMode);
    if (s.backdropFilter && s.backdropFilter !== 'none') own.push('backdrop-filter ' + s.backdropFilter);
    if (own.length) effects.push({ tag: el.localName, root: el === root, values: own });
  }
  // The pseudo-classes the element is in as read (a pointer over it, focus in it).
  const state = { hover: root.matches(':hover'), focus: root.matches(':focus-within'), active: root.matches(':active'), link: root.matches(':any-link'), focusedWindow: document.hasFocus() };
  const running = typeof document.getAnimations === 'function' ? document.getAnimations().filter((a) => a.playState === 'running' && a.effect && a.effect.target && (a.effect.target === root || root.contains(a.effect.target))).length : 0;
  return { nodes, backdrop, effects, state, running, rootRect: [rootRect.x, rootRect.y, rootRect.width, rootRect.height] };
}`;

/** The face each text-bearing element was drawn in, from the renderer itself (CSS.getPlatformFontsForNode). */
async function renderedFonts(page, rootSelector, nodes) {
  const out = new Map();
  try {
    await page.send("DOM.enable");
    await page.send("CSS.enable");
    const { root } = await page.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: rootSelector });
    if (!nodeId) return out;
    const { nodeIds } = await page.send("DOM.querySelectorAll", { nodeId, selector: "*" });
    const ids = [nodeId, ...nodeIds];
    for (const node of nodes) {
      if (node.text.trim() === "" || ids[node.i] === undefined) continue;
      try {
        const { fonts } = await page.send("CSS.getPlatformFontsForNode", { nodeId: ids[node.i] });
        const main = [...fonts].sort((a, b) => b.glyphCount - a.glyphCount)[0];
        if (main) out.set(node.i, main.familyName);
      } catch {
        // An element with no layout has no glyphs; nothing to compare.
      }
    }
  } catch {
    // A page that refuses the DOM domain leaves the fonts uncompared; every other difference still comes out.
  }
  return out;
}

/** The live instance of one state, read under the window's lock with its pseudo-class held. */
async function readLive(liveMatch, port, state, space) {
  const tab = await findPage(liveMatch, port);
  if (!tab) throw new Error(`no open tab matches "${liveMatch}" on port ${port}; the product page must be open in the Proto window`);
  const live = await connect(tab.webSocketDebuggerUrl);
  try {
    return await withForcedState(live, state.live.selector, state.live.force, async () => {
      const read = await evaluate(live, `(${READ_SUBTREE})(${JSON.stringify(state.live.selector)}, ${JSON.stringify([...COLOUR_PROPS])}, ${JSON.stringify(REF_ATTRS)}, ${JSON.stringify(REF_PROPS)}, ${JSON.stringify(space)})`);
      if (!read) throw new Error(`nothing on the live page matches ${state.live.selector} (state ${state.name})`);
      read.fonts = await renderedFonts(live, state.live.selector, read.nodes);
      return read;
    });
  } finally {
    live.close();
  }
}

/** Our copy of one state, rendered alone on the render route at the live rect. */
async function readReplica(appUrl, slug, state, rect, viewport, display, theme) {
  const url = new URL(`${appUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("__protoTheme", theme);
  url.hash = `/render/${encodeURIComponent(slug)}/${encodeURIComponent(state.name)}?x=${rect[0]}&y=${rect[1]}&w=${rect[2]}`;
  const page = await headlessPage(url.toString(), { ...viewport, display });
  try {
    const outcome = await evaluate(page.page, "new Promise((done) => { const until = Date.now() + 15000; const tick = () => { const root = document.querySelector('[data-render]'); if (root && !document.querySelector('[data-loading]')) done(root.dataset.render); else if (Date.now() > until) done(null); else setTimeout(tick, 50); }; tick(); })");
    if (outcome === null) throw new Error(`the render route did not mount ${slug}/${state.name} within 15 s`);
    if (outcome !== "ok") throw new Error(`the render route could not show ${slug}/${state.name}: ${outcome}`);
    await evaluate(page.page, "document.fonts.ready.then(() => document.fonts.status)");
    const selector = '[data-render="ok"] > *';
    const read = await evaluate(page.page, `(${READ_SUBTREE})(${JSON.stringify(selector)}, ${JSON.stringify([...COLOUR_PROPS])}, ${JSON.stringify(REF_ATTRS)}, ${JSON.stringify(REF_PROPS)}, ${JSON.stringify(display.colorProfile)})`);
    if (!read) throw new Error(`the render route showed ${slug}/${state.name} with nothing inside`);
    read.fonts = await renderedFonts(page.page, selector, read.nodes);
    return read;
  } finally {
    await page.close();
  }
}

// ---- comparing ----

/** The copy's own name for an element: its CSS-module class (styles["text2"] renders as _text2_<hash>_<n>), else its tag. */
function nameOf(node) {
  for (const token of (node.attrs.class ?? "").split(/\s+/)) {
    const m = /^_?([A-Za-z][A-Za-z0-9-]*)_[A-Za-z0-9]+_\d+$/.exec(token);
    if (m && !/^(variant|interaction)-/.test(m[1])) return m[1];
  }
  return node.tag;
}

/** Index pairs of a longest common subsequence of two key lists (the same as snapshot.mjs uses to unify looks). */
function lcs(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

const depthOf = (nodes, i) => {
  let d = 0;
  for (let p = nodes[i].parent; p !== -1; p = nodes[p].parent) d++;
  return d;
};

// Two values agree when every number in them is within a fiftieth of a
// pixel and the rest of the text is the same: "22.001px" is "22px".
function sameValue(a, b) {
  if (a === b) return true;
  const na = a.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const nb = b.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  if (na.length !== nb.length || na.length === 0) return false;
  if (a.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/g, "#") !== b.replace(/-?\d*\.?\d+(?:e[-+]?\d+)?/g, "#")) return false;
  return na.every((v, i) => Math.abs(parseFloat(v) - parseFloat(nb[i])) <= 0.02);
}

const samePixels = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

// A property's value in words: the pixels a colour drew as, else the value.
const shown = (value) => (value.length > 80 ? `${value.slice(0, 77)}...` : value);

/** Whether a box (relative to the root) touches one of the pass's differing clusters. */
function inClusters(rect, clusters) {
  const [x, y, w, h] = rect;
  return clusters.some(({ cssRect: [cx, cy, cw, ch] }) => x < cx + cw + 1 && cx < x + w + 1 && y < cy + ch + 1 && cy < y + h + 1);
}

// Properties that carry no look of their own: their value is a
// position on the page or an engine detail, and they never explain a
// pixel. Sizes and margins (DECLARED_SET) are compared; a root's
// offsets and position are not (tools/snapshot.mjs places the root
// itself), nor are the origins a transform is measured from (they
// follow the size, which is compared).
const uncompared = (name) => (skipped(name) && !DECLARED_SET.has(name)) || name === "transform-origin" || name === "perspective-origin";
const ROOT_PLACEMENT = new Set(["position", "top", "right", "bottom", "left", "z-index"]);
// An auto minimum resolves to 0px out of flow and to auto in a grid cell: the same thing.
const sameMinimum = (a, b) => (a === "auto" && b === "0px") || (a === "0px" && b === "auto");

/** The two sides' elements matched in document order by tag and depth: [[live index, our index], …]. */
function pairNodes(live, mine) {
  const key = (nodes, n) => `${n.tag}@${depthOf(nodes, n.i)}`;
  return lcs(live.nodes.map((n) => key(live.nodes, n)), mine.nodes.map((n) => key(mine.nodes, n)));
}

/**
 * Every concrete difference between the product's instance and our
 * copy, most telling first: references that point at nothing, images
 * that did not load, a text drawn in another face, elements one side
 * lacks, then text, attributes, boxes and computed style, and inside
 * each kind the differences inside the pass's clusters first.
 */
function compare(live, mine, clusters) {
  const out = [];
  const element = (node, side) => ({ index: node.i, name: side === "mine" ? nameOf(node) : node.tag, tag: node.tag, text: node.text.trim().slice(0, 40) });
  const add = (kind, node, side, rest) => out.push({ kind, element: element(node, side), inCluster: inClusters(node.rect, clusters), ...rest });

  // Our copy's own broken references, before anything else: a gradient
  // or clip whose id was dropped paints nothing, and every pixel it
  // owned differs.
  for (const node of mine.nodes) {
    for (const ref of node.references.filter((r) => !r.found)) {
      // What the product's own element points at here (our ids are rewritten), and whether the component defines it.
      const twin = live.nodes[node.i];
      const liveValue = ref.where === "style" ? twin?.style[ref.name] : twin?.attrs[ref.name];
      const liveId = localRefsIn(liveValue ?? "")[0] ?? ref.id;
      const defined = live.nodes.find((n) => n.attrs.id === liveId);
      add("reference", node, "mine", {
        property: ref.name,
        product: `${liveValue ?? "not set"}`,
        here: `points at #${ref.id}, which no element here has`,
        id: liveId,
        note: defined ? `the product defines it on a <${defined.tag}> inside the component (its id was not kept)` : "the product defines it outside the component",
      });
    }
  }
  for (const node of mine.nodes) {
    if (node.image && !node.image.loaded) add("image", node, "mine", { property: "src", product: basename(live.nodes[node.i]?.image?.src ?? "") || "an image", here: `${basename(node.image.src) || "nothing"} did not load` });
  }

  const pairs = pairNodes(live, mine);
  const matchedLive = new Set(pairs.map(([a]) => a));
  const matchedMine = new Set(pairs.map(([, b]) => b));
  for (const node of live.nodes) if (!matchedLive.has(node.i)) add("structure", node, "live", { property: "element", product: `<${node.tag}>${node.text.trim() ? ` "${node.text.trim().slice(0, 30)}"` : ""}`, here: "no such element" });
  for (const node of mine.nodes) if (!matchedMine.has(node.i)) add("structure", node, "mine", { property: "element", product: "no such element", here: `<${node.tag}>${node.text.trim() ? ` "${node.text.trim().slice(0, 30)}"` : ""}` });

  for (const [a, b] of pairs) {
    const theirs = live.nodes[a];
    const ours = mine.nodes[b];
    const liveFont = live.fonts.get(a);
    const mineFont = mine.fonts.get(b);
    if (liveFont && mineFont && liveFont !== mineFont) add("font", ours, "mine", { property: "font", product: `drawn in ${liveFont}`, here: `drawn in ${mineFont}`, note: `font-family is ${shown(ours.style["font-family"] ?? "")}` });
    if (theirs.text.trim() !== ours.text.trim()) add("text", ours, "mine", { property: "text", product: JSON.stringify(theirs.text.trim().slice(0, 60)), here: JSON.stringify(ours.text.trim().slice(0, 60)) });
    if (theirs.value !== null && theirs.value !== ours.value) add("text", ours, "mine", { property: "value", product: JSON.stringify(theirs.value), here: JSON.stringify(ours.value ?? "") });
    for (const name of new Set([...Object.keys(theirs.attrs), ...Object.keys(ours.attrs)])) {
      if (OWN_ATTRS.test(name)) continue;
      // The writer's own additions: every button is type="button", every field readOnly.
      if (name === "type" && ours.tag === "button") continue;
      if (name === "readonly" && (ours.tag === "input" || ours.tag === "textarea")) continue;
      let product = theirs.attrs[name];
      let here = ours.attrs[name];
      if (name === "src" || name === "href" || name === "xlink:href") {
        product = product === undefined ? undefined : basename(product.split("?")[0]);
        here = here === undefined ? undefined : basename(here.split("?")[0]);
      }
      // A reference by id is judged above by whether it resolves, not by the id's spelling.
      if (product !== undefined && here !== undefined && /#/.test(product) && /#/.test(here)) continue;
      if (product === here) continue;
      // Attributes that never paint, and an empty one against none where only presence would paint.
      if (INERT_ATTRS.has(name)) continue;
      if (!PRESENCE_ATTRS.has(name) && (product ?? "") === "" && (here ?? "") === "") continue;
      add("attribute", ours, "mine", { property: name, product: product === undefined ? "not set" : shown(product), here: here === undefined ? "not set" : shown(here) });
    }
    // Boxes: where the element sits inside the root and how big it is.
    const [lx, ly, lw, lh] = theirs.rect;
    const [mx, my, mw, mh] = ours.rect;
    const moved = Math.abs(lx - mx) > 0.5 || Math.abs(ly - my) > 0.5;
    const resized = Math.abs(lw - mw) > 0.5 || Math.abs(lh - mh) > 0.5;
    if (b === 0 && resized) add("box", ours, "mine", { property: "size", product: `${round(lw)} x ${round(lh)}`, here: `${round(mw)} x ${round(mh)}` });
    else if (b !== 0 && (moved || resized)) {
      add("box", ours, "mine", {
        property: "box",
        product: `${round(lw)} x ${round(lh)} at ${round(lx)}, ${round(ly)}`,
        here: `${round(mw)} x ${round(mh)} at ${round(mx)}, ${round(my)}`,
      });
    }
    const rootSized = b === 0 && !resized;
    for (const name of Object.keys(theirs.style)) {
      if (uncompared(name)) continue;
      if (b === 0 && ROOT_PLACEMENT.has(name)) continue;
      // The root's margins lie outside the box the render route shows;
      // its other layout values say how its neighbours place it.
      if (b === 0 && /^margin-/.test(name)) continue;
      if (b === 0 && name === "display" && blockified(theirs.style[name], ours.style[name] ?? "")) continue;
      if (rootSized && ROOT_LAYOUT.test(name)) continue;
      // A child's margin that moved nothing (its box is the product's) changes no pixel.
      if (b !== 0 && /^margin-/.test(name) && !moved && !resized) continue;
      const product = theirs.style[name];
      const here = ours.style[name];
      if (here === undefined) continue;
      if (/^(min|max)-(width|height)$/.test(name) && sameMinimum(product, here)) continue;
      // A colour that never paints is no difference: an outline with no style, a border with no width.
      if (name === "outline-color" && theirs.style["outline-style"] === "none" && ours.style["outline-style"] === "none") continue;
      if (COLOUR_PROPS.has(name)) {
        if (theirs.colours[name] && ours.colours[name] && samePixels(theirs.colours[name], ours.colours[name])) continue;
        if (product === here) continue;
      } else if (sameValue(product, here)) continue;
      // A reference is judged by whether it resolves, above.
      if (REF_PROPS.includes(name) && /url\(\s*["']?#/.test(product) && /url\(\s*["']?#/.test(here)) continue;
      // A colour that never paints (a border with no width) is no difference.
      if (/^border-(top|right|bottom|left)-color$/.test(name) && theirs.style[name.replace("color", "width")] === "0px" && ours.style[name.replace("color", "width")] === "0px") continue;
      add("style", ours, "mine", { property: name, product: shown(product), here: shown(here), inherited: INHERITED.has(name) });
    }
    for (const which of new Set([...Object.keys(theirs.pseudo), ...Object.keys(ours.pseudo)])) {
      const p = theirs.pseudo[which];
      const o = ours.pseudo[which];
      if (!p || !o) {
        add("style", ours, "mine", { property: which, product: p ? `content ${p.content}` : "none", here: o ? `content ${o.content}` : "none" });
        continue;
      }
      for (const name of ["content", "color", "background-color", "width", "height", "font-family", "font-size", "font-weight", "opacity", "background-image", "border-top-width", "border-top-color"]) {
        if (p[name] !== undefined && o[name] !== undefined && !sameValue(p[name], o[name])) add("style", ours, "mine", { property: `${which} ${name}`, product: shown(p[name]), here: shown(o[name]) });
      }
    }
  }
  // The colour behind the component: our copy paints component.json's backdrop; the product composites its ancestors.
  if (live.backdrop && mine.backdrop && !samePixels(live.backdrop, mine.backdrop)) {
    out.unshift({ kind: "backdrop", element: element(mine.nodes[0], "mine"), inCluster: true, property: "backdrop", product: rgb(live.backdrop), here: rgb(mine.backdrop), note: "the colour the component sits on (component.json backdrop, per state)" });
  }
  const order = { colour: -1, reference: 0, image: 1, font: 2, backdrop: 3, structure: 4, text: 5, attribute: 6, box: 7, style: 8 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || Number(b.inCluster) - Number(a.inCluster));
}

/** Whether a colour property paints anything on this element. */
function paints(node, name) {
  const s = node.style;
  if (/^border-(top|right|bottom|left)-color$/.test(name)) return s[name.replace("color", "width")] !== "0px" && s[name.replace("color", "style")] !== "none";
  if (name === "outline-color") return s["outline-style"] !== "none" && s["outline-width"] !== "0px";
  if (name === "color" || name === "-webkit-text-fill-color" || name === "text-decoration-color") return node.text.trim() !== "";
  if (name === "fill" || name === "stroke") return node.svg;
  if (name === "background-color") return (node.drawn?.[name]?.[3] ?? 0) > 0;
  return false;
}

/**
 * A uniform colour shift over the component, from the two pictures
 * themselves (tools/colour-shift.mjs), and which computed colour it
 * comes from: { shift, cause, line, properties } or null.
 *   cause "value":   a colour property of the product's draws the
 *                    product's colour; ours draws ours. Fix that value.
 *   cause "effect":  both compute the same colour, and an opacity,
 *                    filter or blend around the product's element
 *                    changes it.
 *   cause "motion":  both compute the same colour; the product's
 *                    element is animating.
 *   cause "capture": both compute the same colour and nothing on the
 *                    page changes it: the product's window drew it as
 *                    another colour (its display's colour profile).
 *   cause "unread":  no computed colour on either side is either one:
 *                    a state the read did not hold, or the page.
 */
function colourFinding(live, mine, pass, pairs) {
  let shift = null;
  try {
    const theirs = decodePng(readFileSync(pass.live));
    const ours = decodePng(readFileSync(pass.screenshot));
    shift = colourShift(theirs, ours);
    const dpr = pass.display?.dpr ?? 1;
    for (const { cssRect: [x, y, w, h] } of shift ? [] : pass.clusters.slice(0, 3)) {
      shift = colourShift(theirs, ours, [x * dpr, y * dpr, w * dpr, h * dpr]);
      if (shift) break;
    }
  } catch {
    return null;
  }
  if (!shift) return null;
  const near = (c, target) => Array.isArray(c) && c[3] > 0 && channelDelta(c, target) <= 3;
  const value = [];
  const same = [];
  for (const [a, b] of pairs) {
    const theirs = live.nodes[a];
    const ours = mine.nodes[b];
    const who = b === 0 ? `root <${ours.tag}>` : `${nameOf(ours)} <${ours.tag}>`;
    for (const name of COLOUR_PROPS) {
      if (!paints(ours, name) && !paints(theirs, name)) continue;
      const o = ours.drawn?.[name];
      const l = theirs.drawn?.[name];
      if (near(l, shift.live) && near(o, shift.ours)) value.push({ element: who, property: name, product: theirs.style[name], here: ours.style[name] });
      else if (near(o, shift.ours) && near(l, shift.ours)) same.push({ element: who, property: name, product: theirs.style[name], here: ours.style[name] });
    }
  }
  const head = `the whole box is drawn another colour: ${rgbText(shift.live)} in the product's picture, ${rgbText(shift.ours)} in ours, over ${Math.round(shift.share * 100)}% of it (${Math.round(shift.explained * 100)}% of the differing pixels)${shift.uniform && shift.pairs.length > 1 ? `; every colour in it moved the same way (${shift.pairs.filter((p) => channelDelta(p.live, p.ours) > 2).map((p) => `${rgbText(p.ours)} -> ${rgbText(p.live)}`).join(", ")})` : ""}`;
  const named = (list) => list.slice(0, 3).map((p) => `${p.element} ${p.property}`).join(", ");
  if (value.length > 0) {
    const first = value[0];
    return { shift, cause: "value", properties: value, line: `${head}. ${named(value)} draws it: ${first.property} is ${first.product} in the product, ${first.here} here; write the product's` };
  }
  if (same.length > 0) {
    const computed = `${named(same)} computes ${same[0].product} on both sides, which draws as ${rgbText(shift.ours)}, so no value of the component's differs`;
    const theirEffects = live.effects.filter((e) => !mine.effects.some((m) => m.values.join() === e.values.join()));
    if (theirEffects.length > 0) return { shift, cause: "effect", properties: same, line: `${head}. ${computed}: the product's ${theirEffects.map((e) => `<${e.tag}> has ${e.values.join(", ")}`).join("; ")}, which changes every pixel under it` };
    if (live.running > 0) return { shift, cause: "motion", properties: same, line: `${head}. ${computed}: the product's element is animating, and its picture is one frame of it` };
    return {
      shift,
      cause: "capture",
      properties: same,
      line: `${head}. ${computed}. The product's window drew that colour as ${rgbText(shift.live)}: a colour capture difference (the Proto window draws through its screen's colour profile, not sRGB; quit it when no import is running and start it again with tools/cdp/chrome.mjs, which forces sRGB), not a state (a held :hover or :focus changes the computed value, and it did not change)`,
    };
  }
  return { shift, cause: "unread", properties: [], line: `${head}. No computed colour on either side reads ${rgbText(shift.live)} or ${rgbText(shift.ours)} at its pixels: a state the read did not hold (:hover, :focus, :active, :visited), an opacity or filter, or a colour capture difference` };
}

/**
 * What identical computed values with differing pixels imply, in the
 * order worth trying: the line printed instead of a bare "no difference".
 */
function sameValuesMeaning(live, mine, state, finding) {
  const why = [];
  if (!state.live.force && live.state.hover) why.push("the pointer is over it on the page, so the product shows its :hover look; move the pointer off the Proto window");
  if (!state.live.force && live.state.focus && live.state.focusedWindow) why.push("focus is inside it on the page (:focus); click elsewhere on the page");
  if (!state.live.force && live.state.active) why.push("it is held pressed on the page (:active)");
  if (live.running > 0) why.push(`${live.running} animation${live.running === 1 ? " is" : "s are"} running on it: the picture is one frame of it`);
  const root = live.nodes[0].style;
  if (root["transition-duration"] && !/^0s(, 0s)*$/.test(root["transition-duration"])) why.push(`it has a transition (${shown(root["transition-property"] ?? "all")} over ${root["transition-duration"]}); a capture during it reads a value part-way`);
  const theirEffects = live.effects.filter((e) => !mine.effects.some((m) => m.values.join() === e.values.join()));
  if (theirEffects.length > 0) why.push(`the page lays ${theirEffects.map((e) => `${e.values.join(", ")} on <${e.tag}>`).join("; ")} over it`);
  if (live.state.link) why.push("it is a link: :visited colours are never readable by script and follow the browser's history");
  if (why.length === 0 && !finding) why.push("nothing on the page explains it: antialiasing, subpixel text or a colour profile; compare the pass pictures (docs/cdp-traps.md names the renderer traps)");
  return why;
}

/**
 * Whose difference it is: the component's own, or something around it
 * that no change to the component would fix (tools/tail.mjs rule 3).
 */
function blame(live, mine, differences, pass, finding = null) {
  const own = differences.filter((d) => d.kind !== "backdrop" && d.kind !== "colour" && !(d.kind === "reference" && d.note?.includes("outside the component")));
  // A colour no value of the component's would change, covering most of what differs.
  if (finding && ["capture", "effect", "motion"].includes(finding.cause) && finding.shift.explained >= 0.6) {
    const reason = { capture: `its pixels are another colour only in the product's capture (${rgbText(finding.shift.live)} for the ${rgbText(finding.shift.ours)} both sides compute): the Proto window's colour profile`, effect: "the page changes its colours with an opacity, filter or blend around it", motion: "it is animating on the page; the capture is one frame of it" }[finding.cause];
    return { where: "outside", reason };
  }
  const outside = differences.find((d) => d.kind === "reference" && d.note?.includes("outside the component"));
  if (differences.some((d) => d.kind === "backdrop") && own.length === 0) return { where: "outside", reason: `its difference is the colour behind it (${rgb(live.backdrop)} on the page now, ${rgb(mine.backdrop)} here), not the component` };
  if (live.nodes[0].tag !== mine.nodes[0].tag) return { where: "outside", reason: `its live element is another element now (a <${live.nodes[0].tag}>, not the <${mine.nodes[0].tag}> it was read from): the page changed under the selector` };
  const animating = live.nodes.find((n) => (n.style["animation-name"] && n.style["animation-name"] !== "none") || (n.style["transition-property"] && n.style["transition-property"] !== "all" && n.style["transition-duration"] !== "0s" && pass.shifted?.mismatch < pass.mismatch / 2));
  if (animating && own.length === 0) return { where: "outside", reason: `it is animating on the page (<${animating.tag}> ${animating.style["animation-name"] ?? "in transition"}); the capture is one frame of it` };
  if (own.length === 0 && outside) return { where: "outside", reason: `it points at #${outside.id}, which the page defines outside the component` };
  if (own.length === 0 && finding?.cause === "unread") return { where: "unknown", reason: `every value read the same, yet the box is ${rgbText(finding.shift.live)} in the product's picture and ${rgbText(finding.shift.ours)} here: a state the read did not hold, or the capture` };
  if (own.length === 0) return { where: "unknown", reason: "every value read the same; the pixels differ in the rendering itself (docs/cdp-traps.md)" };
  return { where: "item", reason: `${own.length} of its own values differ` };
}

const round = (n) => Math.round(n * 100) / 100;
const rgb = ([r, g, b, a]) => (a === 255 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${round(a / 255)})`);

/** One difference as a plain line. */
function line(d) {
  const who = d.element.text ? `${d.element.name} <${d.element.tag}> "${d.element.text}"` : `${d.element.name} <${d.element.tag}>`;
  const where = d.inCluster ? "" : " (outside the differing area)";
  switch (d.kind) {
    case "reference":
      return `${who}: ${d.property} ${d.product} ${d.here}; ${d.note}${where}`;
    case "image":
      return `${who}: image ${d.here} (the product shows ${d.product})${where}`;
    case "font":
      return `${who}: ${d.product} in the product, ${d.here}; ${d.note}${where}`;
    case "structure":
      return d.product === "no such element" ? `${who}: our copy has an element the product does not (${d.here})${where}` : `${who}: the product has ${d.product} where our copy has none${where}`;
    case "backdrop":
      return `behind the component: ${d.product} in the product, ${d.here} here; ${d.note}`;
    case "colour":
      return d.note;
    case "box":
      return `${who}: ${d.property} is ${d.product} in the product, ${d.here} here${where}`;
    default:
      return `${who}: ${d.property} is ${d.product} in the product, ${d.here} here${where}`;
  }
}

// ---- main ----

export { blame, colourFinding, compare, pairNodes, sameValuesMeaning };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
const options = { theme: "light", port: "9333" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [codebase, slug] = positional;
if (!codebase || !slug) {
  console.error(USAGE);
  process.exit(1);
}
if (!["light", "dark"].includes(options.theme)) {
  console.error("--theme is light or dark");
  process.exit(1);
}
const home = join(process.env.HOME ?? "", ".proto", codebase);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

let target;
let stopDev = () => {};
if (options.build) {
  const buildDir = buildFolder(codebase, options.build);
  const need = (name) => {
    const path = join(buildDir, name);
    if (!existsSync(path)) fail(`${path} does not exist: run proto-build.mjs first`);
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const workspace = need("workspace.json");
  const tree = need("tree.json");
  const dev = await ensureDevServer({ workspace: workspace.path, logPath: join(buildDir, "dev.log"), keep: true });
  stopDev = () => dev.stop();
  target = { unitPath: join(workspace.path, "src", "parts", slug, "component.json"), appUrl: dev.url, liveMatch: liveMatchOf(tree.url), out: join(buildDir, "explain", slug) };
} else {
  const library = join(home, "library");
  const liveUrl = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source?.liveUrl;
  if (!liveUrl) fail(`${home}/codebase.json has no source.liveUrl`);
  const tunnel = join(home, "run", "library", "tunnel.json");
  if (!existsSync(tunnel)) fail(`the library is not being served: run node tools/host-library.mjs ${codebase}`);
  target = { unitPath: join(library, "src", "components", slug, "component.json"), appUrl: `http://localhost:${JSON.parse(readFileSync(tunnel, "utf8")).port}`, liveMatch: liveMatchOf(liveUrl), out: join(home, "run", "explain", slug) };
}
if (!existsSync(target.unitPath)) fail(`${target.unitPath} does not exist: write the component before explaining it`);
// A unit's first step is this read, before any edit: the folder as the
// tools wrote it is kept here, and the check that stops the unit puts it
// back when the unit did not get to a match (tools/unit-restore.mjs).
const kept = keepFolder({ folder: dirname(target.unitPath), slug, runDir: options.build ? buildFolder(codebase, options.build) : join(home, "run") });
if (kept.kept) console.error(`… kept a copy of the folder as it is now at ${kept.path}; a check that stops the unit restores it`);
const unit = JSON.parse(readFileSync(target.unitPath, "utf8"));
let states = unit.states.filter((s) => s.live);
if (options.state) states = states.filter((s) => s.name === options.state);
if (states.length === 0) fail(options.state ? `state "${options.state}" has no live instance in component.json` : "no state in component.json names a live instance");
mkdirSync(target.out, { recursive: true });
const port = Number(options.port);
// A positional selector the page shifted under (a reload dropped a flash
// message) resolves to the position-free one snapshot.mjs recorded.
states = await resolveStates(states, target.liveMatch, port);

// A minute per state at most: a read waits behind other lanes for the window's lock.
setTimeout(() => fail(`explain-diff gave up after ${states.length} minute(s); check the live tab is still open and try again`), 60_000 * states.length).unref();

const report = { slug, states: [] };
try {
  for (const state of states) {
    let pass;
    try {
      pass = await verifyPass({ appUrl: target.appUrl, slug, state: state.name, liveMatch: target.liveMatch, target: { selector: state.live.selector }, force: state.live.force, out: target.out, port, theme: options.theme });
    } catch (error) {
      if (!/nothing on the live page matches/.test(error.message)) throw error;
      // The page changed under a positional selector (a reload dropped a
      // message above it): no value of the component's is to blame.
      const entry = { state: state.name, verdict: "failed", differences: [], blame: { where: "outside", reason: `its live element is gone: nothing on the page matches ${state.live.selector} any more (was the product tab reloaded or navigated? a position shifts when the page drops an element before it)` } };
      report.states.push(entry);
      console.error(`${state.name}: not its fault, ${entry.blame.reason}`);
      continue;
    }
    const entry = { state: state.name, verdict: pass.verdict, mismatch: pass.mismatch, clusters: pass.clusters.slice(0, 6), pictures: { live: pass.live, ours: pass.screenshot, diff: pass.diff }, differences: [] };
    report.states.push(entry);
    if (ACCEPTED.includes(pass.verdict)) {
      console.error(`${state.name}: ${pass.activity.toLowerCase()} (${pass.verdict}); nothing to fix`);
      continue;
    }
    let live;
    try {
      live = await readLive(target.liveMatch, port, state, pass.display.colorProfile);
    } catch (error) {
      if (!/nothing on the live page matches/.test(error.message)) throw error;
      entry.blame = { where: "outside", reason: `its live element is gone: nothing on the page matches ${state.live.selector} any more` };
      console.error(`${state.name}: not its fault, ${entry.blame.reason}`);
      continue;
    }
    const mine = await readReplica(target.appUrl, slug, state, live.rootRect, { width: pass.viewport[0], height: pass.viewport[1] }, pass.display, options.theme);
    live.fonts = live.fonts ?? new Map();
    mine.fonts = mine.fonts ?? new Map();
    entry.differences = compare(live, mine, pass.clusters);
    // A colour over the whole box is told first, from the pictures themselves:
    // no margin or attribute explains a button drawn another blue.
    const finding = colourFinding(live, mine, pass, pairNodes(live, mine));
    if (finding) {
      entry.colour = { cause: finding.cause, product: rgbText(finding.shift.live), here: rgbText(finding.shift.ours), share: finding.shift.share, explained: finding.shift.explained, uniform: finding.shift.uniform, properties: finding.properties };
      entry.differences.unshift({ kind: "colour", element: { index: 0, name: "root", tag: mine.nodes[0].tag, text: "" }, inCluster: true, property: "colour", product: entry.colour.product, here: entry.colour.here, cause: finding.cause, note: finding.line });
    }
    if (live.backdrop) entry.backdrop = { product: rgb(live.backdrop), here: mine.backdrop ? rgb(mine.backdrop) : "none" };
    entry.blame = blame(live, mine, entry.differences, pass, finding);
    if (entry.blame.where === "outside") console.error(`${state.name}: not its fault, ${entry.blame.reason}`);
    const inside = entry.differences.filter((d) => d.inCluster).length;
    console.error(`${state.name}: ${pass.activity.toLowerCase()} (${pass.mismatch} px in ${pass.clusters.length} cluster${pass.clusters.length === 1 ? "" : "s"}); ${entry.differences.length} difference${entry.differences.length === 1 ? "" : "s"}, ${inside} inside the differing area`);
    for (const d of entry.differences.slice(0, SHOWN)) console.error(`  ${line(d)}`);
    if (entry.differences.length > SHOWN) console.error(`  ... ${entry.differences.length - SHOWN} more in the JSON`);
    if (entry.differences.filter((d) => d.kind !== "colour").length === 0) {
      // Every value read the same: say what that leaves, not just that it is so.
      const meaning = sameValuesMeaning(live, mine, state, finding);
      entry.meaning = meaning;
      console.error(`  no computed difference: every value read the same, so the pixels differ for a reason outside the component's values${finding ? " (the colour above)" : ""}${meaning.length ? ":" : ""}`);
      for (const m of meaning) console.error(`    - ${m}`);
    }
  }
} catch (error) {
  stopDev();
  fail(error.message);
}
stopDev();
console.log(JSON.stringify(report));
}
