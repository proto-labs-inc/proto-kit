#!/usr/bin/env node
/**
 * Write a component from the product's own rendering, in one call: the
 * live instances of its states become src/components/<slug>/ (the
 * module, its scoped stylesheet, its fonts and images, component.json
 * and notes.md), ready for tools/check.mjs to compare with the product.
 *
 * Usage: node tools/snapshot.mjs <codebase> <json>      (<json> literal or @file)
 *   {
 *     "slug": "button", "name": "Button",
 *     "states": [
 *       { "name": "Default", "selector": "<css>" },                    // the default, first
 *       { "name": "Primary", "selector": "<css>" },                    // a variant: another instance
 *       { "name": "Hover", "selector": "<css>", "force": "hover" },    // a pseudo-class held on an instance
 *       { "name": "Primary hover", "selector": "<css>", "force": "hover", "of": "Primary" }
 *     ]
 *   }
 *
 * Nothing is guessed. Every value is read from the live page:
 *   - each element's computed style, keeping only what differs from the
 *     same element in the library app (its base styles sit under every
 *     component, so a value equal to the app's is inherited, not
 *     repeated); inherited properties are set on the root and wherever
 *     a descendant changes them;
 *   - sizes fitted against the product: each look is rendered alone in
 *     the library app and every element whose box comes out a different
 *     size is pinned (100% where it fills its parent, else its size), so
 *     widths stay free wherever the layout gives them; margins, offsets
 *     and grid tracks (as fractions when equal) from the computed style;
 *   - fonts from the page's own @font-face rules, copied beside the
 *     stylesheet; images and icons copied or inlined;
 *   - the backdrop: the colour the component sits on in the product
 *     (its painted ancestors, composited), so the library shows and
 *     compares it on that colour;
 *   - the palette colours it uses, matched against the manifest's tokens.
 *
 * Variants (states without `force`) become one `variant` prop; states
 * held with a pseudo-class become an `interaction` prop whose forced
 * class shares its rule with the pseudo-class. The first text in the
 * component becomes `children`; other texts that differ between states
 * become props. The live element never changes: a pseudo-class is held
 * with CSS.forcePseudoState and released straight after the read.
 *
 * Prints one JSON line: { slug, module, states, tokens, backdrop, nodes, fonts, images }.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { findPage } from "./cdp/attach.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { displayOf, headlessPage } from "./cdp/headless.mjs";
import { FORCEABLE, withForcedState } from "./verify-replica.mjs";

const USAGE = "usage: node tools/snapshot.mjs <codebase> <json | @file>";

// ---- what to copy ----

// Properties a child takes from its parent unless it sets them.
const INHERITED = new Set([
  "color", "cursor", "direction", "visibility", "white-space", "white-space-collapse", "text-wrap-mode", "text-wrap-style",
  "font-family", "font-size", "font-style", "font-weight", "font-stretch", "font-variant", "font-variant-caps",
  "font-variant-east-asian", "font-variant-ligatures", "font-variant-numeric", "font-variant-alternates", "font-variant-position",
  "font-feature-settings", "font-variation-settings", "font-kerning", "font-optical-sizing", "font-palette", "font-size-adjust",
  "font-synthesis-weight", "font-synthesis-style", "font-synthesis-small-caps",
  "line-height", "letter-spacing", "word-spacing", "text-align", "text-align-last", "text-indent", "text-transform",
  "text-shadow", "text-rendering", "text-underline-position", "text-underline-offset", "text-decoration-skip-ink",
  "text-emphasis-color", "text-emphasis-position", "text-emphasis-style", "text-size-adjust", "text-autospace", "text-spacing-trim",
  "word-break", "overflow-wrap", "line-break", "hyphens", "tab-size", "quotes", "orphans", "widows",
  "list-style-image", "list-style-position", "list-style-type", "caret-color", "accent-color", "color-scheme",
  "pointer-events", "image-rendering", "writing-mode", "text-orientation", "paint-order", "ruby-position",
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-dasharray", "stroke-dashoffset", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-opacity", "stroke-width", "marker-start", "marker-mid", "marker-end",
  "clip-rule", "color-interpolation", "color-interpolation-filters", "color-rendering", "shape-rendering", "text-anchor",
  "dominant-baseline", "border-collapse", "border-spacing", "caption-side", "empty-cells", "speak", "math-depth", "math-style",
  "-webkit-font-smoothing", "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
  "-webkit-border-horizontal-spacing", "-webkit-border-vertical-spacing", "-webkit-locale", "-webkit-rtl-ordering",
  "-webkit-text-combine", "-webkit-text-security", "-webkit-user-modify", "-webkit-line-break", "-webkit-highlight",
  "-webkit-tap-highlight-color", "-webkit-hyphenate-character",
]);

// Sizes, margins, offsets and grid tracks: written by layoutOf, from
// the computed style and fitted against the product, never copied
// wholesale (a computed width is the pixels it came to on this page).
const DECLARED = [
  "width", "height", "min-width", "min-height", "max-width", "max-height", "flex-basis",
  "top", "right", "bottom", "left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "grid-template-columns", "grid-template-rows", "grid-auto-columns", "grid-auto-rows",
  "line-height",
];
const DECLARED_SET = new Set(DECLARED);
// Never copied: logical duplicates of physical properties the computed
// style also lists, animation machinery with no keyframes behind it,
// SVG geometry that lives in attributes, and engine internals.
function skipped(name) {
  if (name.startsWith("--")) return true;
  if (DECLARED_SET.has(name)) return true;
  if (/^border-(start|end)-(start|end)-radius$/.test(name)) return true;
  if (/-(inline|block)(-|$)/.test(name) || /^(inline|block)-size$/.test(name)) return true;
  if (/^(min|max)-(inline|block)-size$/.test(name)) return true;
  if (/^inset/.test(name)) return true;
  if (/^(animation|scroll-timeline|view-timeline|timeline-|view-transition|anchor-|position-(anchor|area|try|visibility)|contain-intrinsic|scroll-margin|scroll-padding|scroll-snap|overflow-anchor|overflow-clip-margin|interpolate-size|reading-|offset-|app-region|buffered-rendering|zoom$|content$|counter-|page$|size$|speak$)/.test(name)) return true;
  if (["d", "cx", "cy", "r", "rx", "ry", "x", "y"].includes(name)) return true;
  if (name.startsWith("-webkit-") && !INHERITED.has(name) && !/^-webkit-(line-clamp|box-orient|box-decoration-break|mask)/.test(name)) return true;
  return false;
}

// ---- reading the page ----

/** Everything about one instance, read in one evaluate. */
const READ_INSTANCE = String.raw`(rootSelector) => {
  const root = document.querySelector(rootSelector);
  if (!root) return null;
  const elements = [root, ...root.querySelectorAll('*')];
  const index = new Map(elements.map((el, i) => [el, i]));
  const styleOf = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo);
    const out = {};
    for (let i = 0; i < s.length; i++) out[s[i]] = s.getPropertyValue(s[i]);
    return out;
  };
  const nodes = elements.map((el, i) => {
    const children = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1 && index.has(child)) children.push({ node: index.get(child) });
      else if (child.nodeType === 3) children.push({ text: child.textContent });
    }
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    // An image is the file the browser picked for this display, not its 1x fallback.
    if (el.tagName === 'IMG' && el.currentSrc) { attrs.src = el.currentSrc; delete attrs.srcset; delete attrs.sizes; }
    const pseudo = {};
    for (const which of ['::before', '::after', '::placeholder', '::marker']) {
      const s = getComputedStyle(el, which);
      if (which === '::placeholder') {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') pseudo[which] = styleOf(el, which);
        continue;
      }
      if (which === '::marker') continue;
      if (s.content && s.content !== 'none' && s.content !== 'normal') pseudo[which] = styleOf(el, which);
    }
    const r = el.getBoundingClientRect();
    // The element's own name: an SVG's is case-sensitive (linearGradient, clipPath).
    const tag = el.localName;
    return {
      i, tag, svg: el.namespaceURI === 'http://www.w3.org/2000/svg',
      parent: i === 0 ? -1 : index.get(el.parentElement) ?? -1,
      attrs, children, style: styleOf(el), pseudo,
      value: tag === 'input' || tag === 'textarea' ? el.value : null,
      rect: [r.x, r.y, r.width, r.height],
    };
  });
  // The colour the component sits on: its painted ancestors from the
  // first opaque one up, composited in the display's own gamut.
  const layers = [];
  for (let el = root.parentElement; el; el = el.parentElement) {
    const bg = getComputedStyle(el).backgroundColor;
    layers.push(bg);
    const probe = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    probe.fillStyle = bg; probe.fillRect(0, 0, 1, 1);
    if (probe.getImageData(0, 0, 1, 1).data[3] === 255) break;
  }
  if (layers.length === 0 || !document.body) layers.push(getComputedStyle(document.documentElement).backgroundColor);
  layers.reverse();
  const visible = layers.filter((c) => { const p = document.createElement('canvas').getContext('2d'); p.fillStyle = c; p.fillRect(0, 0, 1, 1); return p.getImageData(0, 0, 1, 1).data[3] > 0; });
  let backdrop = null;
  if (visible.length === 1) backdrop = visible[0];
  else if (visible.length > 1) {
    const c = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
    for (const layer of visible) { c.fillStyle = layer; c.fillRect(0, 0, 1, 1); }
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    backdrop = 'color(display-p3 ' + [r, g, b].map((v) => +(v / 255).toFixed(4)).join(' ') + ')';
  }
  // How much room the root had: its parent's content width.
  let room = null;
  if (root.parentElement) {
    const ps = getComputedStyle(root.parentElement);
    room = root.parentElement.getBoundingClientRect().width - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight) - parseFloat(ps.borderLeftWidth) - parseFloat(ps.borderRightWidth);
  }
  return {
    nodes, backdrop, room,
    rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
    base: location.href,
  };
}`;

// ---- layout ----

/**
 * The layout values to write for one element, from its computed style:
 * margins and offsets as the page computes them (exact at the product's
 * width), grid tracks as fractions when they are equal and fill their
 * container, and a width or height only where fitting found the
 * component needs one (`fit`), or where the element is drawn at a size
 * its content does not give it (an image, an icon, an empty box).
 */
function layoutOf(node, nodes, fit, isRoot, room = null) {
  const st = node.style;
  const out = {};
  if (!isRoot) {
    for (const side of ["top", "right", "bottom", "left"]) out[`margin-${side}`] = st[`margin-${side}`];
    if (st.position !== "static") for (const side of ["top", "right", "bottom", "left"]) out[side] = st[side];
  }
  const leaf = node.children.every((c) => c.node === undefined && (c.text === undefined || c.text.trim() === ""));
  const drawn = ["img", "svg", "video", "canvas", "input", "textarea", "select", "iframe"].includes(node.tag) || (leaf && !node.svg);
  const shrinks = isRoot && room !== null && node.rect[2] < room - 0.5 && fit.width === undefined;
  // Every size pinned below is the product's box as measured (or 100% of
  // its parent's content box), padding and border included, so the
  // element is laid out border-box; a content-box minimum or maximum the
  // product states grows by the same padding and border.
  const measured = (drawn && !isRoot) || (shrinks && node.rect[2] >= 240) || fit.width !== undefined || fit.height !== undefined;
  const asBorderBox = measured && st["box-sizing"] === "content-box";
  for (const name of ["min-width", "max-width"]) out[name] = asBorderBox ? borderBoxLength(st[name], st, "width") : st[name];
  for (const name of ["min-height", "max-height"]) out[name] = asBorderBox ? borderBoxLength(st[name], st, "height") : st[name];
  out["flex-basis"] = st["flex-basis"];
  for (const name of ["grid-template-columns", "grid-template-rows"]) {
    const tracks = st[name];
    if (!tracks || tracks === "none") continue;
    out[name] = fractions(tracks, name === "grid-template-columns" ? node.rect[2] : node.rect[3], st) ?? tracks;
  }
  for (const name of ["grid-auto-columns", "grid-auto-rows"]) out[name] = st[name];
  if (drawn && !isRoot) {
    out.width = `${node.rect[2]}px`;
    out.height = `${node.rect[3]}px`;
  }
  // A root that did not fill the room its parent gave it sized to its
  // content in the product; set in a stretching container (the library's
  // stage) it would fill it instead.
  // A large one (a panel) was held to its width by something around it
  // (a page column's maximum), so it keeps that width as its maximum.
  if (shrinks) {
    out.width = "fit-content";
    if (node.rect[2] >= 240) out["max-width"] = `${node.rect[2]}px`;
  }
  if (fit.margin === "left" || fit.margin === "both") out["margin-left"] = "auto";
  if (fit.margin === "both") out["margin-right"] = "auto";
  if (fit.width !== undefined) out.width = fit.width;
  if (fit.height !== undefined) out.height = fit.height;
  if (measured) out["box-sizing"] = "border-box";
  return out;
}

// A content-box length in px as its border-box one: the axis's padding
// and border added. Zero stays zero: no box is smaller than its padding
// and border in either model.
function borderBoxLength(value, st, axis) {
  if (!/^[\d.]+px$/.test(value) || parseFloat(value) === 0) return value;
  const [a, b] = axis === "width" ? ["left", "right"] : ["top", "bottom"];
  const extra = parseFloat(st[`padding-${a}`]) + parseFloat(st[`padding-${b}`]) + parseFloat(st[`border-${a}-width`]) + parseFloat(st[`border-${b}-width`]);
  return `${parseFloat(value) + extra}px`;
}

// "96px 96px 96px" filling a 288px grid → "repeat(3, minmax(0, 1fr))".
function fractions(tracks, size, st) {
  const parts = tracks.trim().split(/\s+/);
  if (parts.length < 2 || !parts.every((p) => /^[\d.]+px$/.test(p))) return null;
  const values = parts.map(parseFloat);
  if (Math.max(...values) - Math.min(...values) > 0.5) return null;
  const gap = parseFloat(st["column-gap"]) || 0;
  const padding = (parseFloat(st["padding-left"]) || 0) + (parseFloat(st["padding-right"]) || 0) + (parseFloat(st["border-left-width"]) || 0) + (parseFloat(st["border-right-width"]) || 0);
  const used = values.reduce((a, b) => a + b, 0) + gap * (values.length - 1);
  if (Math.abs(used - (size - padding)) > 1) return null;
  return `repeat(${values.length}, minmax(0, 1fr))`;
}

/**
 * Render each look alone in the library app (the render route, at the
 * product's width) and compare every element's box with the product's.
 * An element that comes out a different width or height is pinned: 100%
 * where the product's box fills its parent's content box, else its
 * size. Returns whether anything was pinned (the component is written
 * again and fitted once more).
 */
async function fitSizes(appUrl, slug, looks, states, viewport, display) {
  let changed = false;
  for (const inst of looks) {
    const [rx, ry, rw] = inst.nodes[0].rect;
    const url = `${appUrl}/#/render/${encodeURIComponent(slug)}/${encodeURIComponent(inst.state.name)}?x=${rx}&y=${ry}&w=${rw}`;
    const page = await headlessPage(url, { ...viewport, display });
    let rendered;
    try {
      rendered = await evaluate(
        page.page,
        // At most 15 s: a look the route cannot show is left unfitted, never waited on.
        `new Promise((done) => { const until = Date.now() + 15000; const tick = () => { const root = document.querySelector('[data-render="ok"]'); if (root && !document.querySelector('[data-loading]') && root.firstElementChild) { Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))]).then(() => { const el = root.firstElementChild; done([el, ...el.querySelectorAll('*')].map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })); }); } else if (Date.now() > until) done(null); else setTimeout(tick, 50); }; tick(); })`,
      );
    } finally {
      await page.close();
    }
    if (!rendered || rendered.length !== inst.nodes.length) continue;
    inst.nodes.forEach((node, i) => {
      const [, , lw, lh] = node.rect;
      const [, , mw, mh] = rendered[i];
      const parent = i === 0 ? null : inst.nodes[node.parent];
      if (Math.abs(lw - mw) > 0.25 && inst.fit[i].width === undefined) {
        inst.fit[i].width = fills(node, parent, "width") ? "100%" : `${lw}px`;
        changed = true;
      }
      if (Math.abs(lh - mh) > 0.25 && inst.fit[i].height === undefined) {
        inst.fit[i].height = `${lh}px`;
        changed = true;
      }
      // Displaced sideways at the right size: an auto margin the computed
      // style reports as 0px (flex items), pushing it to its parent's end
      // or to the middle.
      const liveX = node.rect[0] - inst.nodes[0].rect[0];
      const mineX = rendered[i][0] - rendered[0][0];
      if (parent && Math.abs(liveX - mineX) > 0.5 && Math.abs(lw - mw) <= 0.25 && inst.fit[i].margin === undefined) {
        const auto = autoMargins(node, parent);
        if (auto) {
          inst.fit[i].margin = auto;
          changed = true;
        }
      }
    });
  }
  return changed;
}

// Which horizontal margins are auto: the box sits flush against its
// parent's content end ("left"), or centred in it ("both"); null if neither.
function autoMargins(node, parent) {
  const st = parent.style;
  const start = parent.rect[0] + parseFloat(st["padding-left"]) + parseFloat(st["border-left-width"]);
  const end = parent.rect[0] + parent.rect[2] - parseFloat(st["padding-right"]) - parseFloat(st["border-right-width"]);
  const left = node.rect[0] - parseFloat(node.style["margin-left"]) - start;
  const right = end - (node.rect[0] + node.rect[2] + parseFloat(node.style["margin-right"]));
  if (Math.abs(right) <= 0.5 && left > 0.5) return "left";
  if (Math.abs(left - right) <= 0.5 && left > 0.5) return "both";
  return null;
}

// Whether a box fills its parent's content box along one axis.
function fills(node, parent, axis) {
  if (!parent) return false;
  const st = parent.style;
  const [a, b] = axis === "width" ? ["left", "right"] : ["top", "bottom"];
  const inner = parent.rect[axis === "width" ? 2 : 3] - parseFloat(st[`padding-${a}`]) - parseFloat(st[`padding-${b}`]) - parseFloat(st[`border-${a}-width`]) - parseFloat(st[`border-${b}-width`]);
  const own = node.rect[axis === "width" ? 2 : 3] + parseFloat(node.style[`margin-${a}`]) + parseFloat(node.style[`margin-${b}`]);
  return Math.abs(own - inner) <= 0.5;
}

// ---- the app's own base ----

/** Computed style of a bare element of each kind inside the library app, the base under every component. */
async function appBaseline(appUrl, kinds, viewport, display) {
  const page = await headlessPage(`${appUrl}/#/render/__baseline__/none`, { ...viewport, display });
  try {
    return await evaluate(
      page.page,
      `(${String.raw`(kinds) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const out = {};
        for (const kind of kinds) {
          const [tag, svg, type] = kind.split('|');
          let el;
          if (svg === '1') {
            const box = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            host.appendChild(box);
            el = tag === 'svg' ? box : box.appendChild(document.createElementNS('http://www.w3.org/2000/svg', tag));
          } else {
            el = host.appendChild(document.createElement(tag));
            if (type) el.setAttribute('type', type);
          }
          const s = getComputedStyle(el);
          const style = {};
          for (let i = 0; i < s.length; i++) style[s[i]] = s.getPropertyValue(s[i]);
          const pseudo = {};
          for (const which of ['::before', '::placeholder']) {
            const p = getComputedStyle(el, which);
            pseudo[which] = {};
            for (let i = 0; i < p.length; i++) pseudo[which][p[i]] = p.getPropertyValue(p[i]);
          }
          out[kind] = { style, pseudo };
        }
        host.remove();
        return out;
      }`})(${JSON.stringify(kinds)})`,
    );
  } finally {
    await page.close();
  }
}

const kindOf = (node) => `${node.tag}|${node.svg ? 1 : 0}|${node.tag === "input" ? node.attrs.type ?? "" : ""}`;

// ---- fonts and images ----

/** The page's @font-face rules, read through the CSS domain (cross-origin sheets included). */
async function fontFaces(live) {
  const sheets = [];
  const listener = live.on("CSS.styleSheetAdded", ({ header }) => sheets.push(header));
  await live.send("DOM.enable");
  await live.send("CSS.disable");
  await live.send("CSS.enable");
  await new Promise((r) => setTimeout(r, 150));
  listener?.();
  const faces = [];
  for (const header of sheets) {
    let text;
    try {
      ({ text } = await live.send("CSS.getStyleSheetText", { styleSheetId: header.styleSheetId }));
    } catch {
      continue;
    }
    for (const match of text.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const body = match[1];
      const family = /font-family\s*:\s*([^;]+)/.exec(body)?.[1].trim().replace(/^["']|["']$/g, "");
      if (!family) continue;
      faces.push({ family, body, base: header.sourceURL || null });
    }
  }
  return faces;
}

const familiesIn = (value) =>
  value
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter((f) => f && !/^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[a-z-]+|-apple-system|emoji|math|fangsong|inherit|initial)$/i.test(f));

async function download(url, to) {
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" } });
  if (!res.ok) throw new Error(`could not fetch a file the component uses (${res.status})`);
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

const fileNameOf = (url, fallback) => {
  try {
    const name = basename(new URL(url).pathname).replace(/[^A-Za-z0-9._-]/g, "");
    return name || fallback;
  } catch {
    return fallback;
  }
};

const IMAGE_TYPES = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

// The file a data: URL holds: its bytes (base64, or percent-encoded text
// such as an SVG) and an extension from its type.
function inlineImage(url) {
  const comma = url.indexOf(",");
  const head = url.slice("data:".length, comma).split(";");
  const data = decodeURIComponent(url.slice(comma + 1));
  const bytes = head.includes("base64") ? Buffer.from(data, "base64") : Buffer.from(data, "utf8");
  return { bytes, extension: IMAGE_TYPES[head[0].toLowerCase()] ?? "png" };
}

// ---- writing the component ----

const pascal = (slug) => slug.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";

const SVG_KEEP_KEBAB = /^(data-|aria-)/;
const HTML_ATTRS = {
  class: null, style: null, for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength",
  autocomplete: "autoComplete", spellcheck: "spellCheck", autofocus: null, contenteditable: "contentEditable",
  "xlink:href": "xlinkHref", "xmlns:xlink": "xmlnsXlink", "xml:space": "xmlSpace", colspan: "colSpan", rowspan: "rowSpan",
};

// Attributes whose presence is their value, and the JSX name each is
// written with (a checked box stays the user's to tick: defaultChecked).
const BOOLEAN_ATTRS = { disabled: "disabled", checked: "defaultChecked" };

// The product's own wiring between elements (ids and the aria
// references to them, tab order) means nothing outside its page.
const PAGE_WIRING = new Set(["id", "tabindex", "aria-describedby", "aria-labelledby", "aria-controls", "aria-owns", "aria-activedescendant", "aria-errormessage", "aria-details", "form"]);

function jsxAttr(name, node) {
  if (PAGE_WIRING.has(name)) return null;
  if (name in HTML_ATTRS) return HTML_ATTRS[name];
  if (name.startsWith("data-") || name.startsWith("on")) return null;
  if (name.startsWith("aria-") || name === "role") return name;
  if (node.svg && !SVG_KEEP_KEBAB.test(name)) return name.replace(/[-:]([a-z])/g, (_, c) => c.toUpperCase());
  const keep = ["type", "placeholder", "href", "src", "alt", "width", "height", "name", "title", "id", "disabled", "checked", "rows", "cols", "target", "rel", "dir", "lang", "viewBox"];
  return keep.includes(name) ? name : null;
}

// Classes named for what the element is, so the stylesheet reads: the
// product's own name for it where it has one (a data-slot, a BEM or
// component class such as LemonButton__icon, a role), else what it is.
const CAMEL = (text) => text.replace(/[^A-Za-z0-9]+([A-Za-z0-9])/g, (_, c) => c.toUpperCase()).replace(/^[A-Z]/, (c) => c.toLowerCase());
function ownName(node) {
  const slot = node.attrs["data-slot"];
  if (slot) return CAMEL(slot);
  for (const token of (node.attrs.class ?? "").split(/\s+/)) {
    const bem = /^[A-Z][A-Za-z0-9]*(?:__([A-Za-z0-9-]+))?(?:--[A-Za-z0-9-]+)?$/.exec(token);
    if (bem?.[1]) return CAMEL(bem[1]);
  }
  const role = node.attrs.role;
  if (role && !["presentation", "none", "img"].includes(role)) return CAMEL(role);
  return null;
}

function nameNodes(nodes) {
  const used = new Map();
  return nodes.map((node, i) => {
    let base = "part";
    const texts = node.children.filter((c) => c.text !== undefined && c.text.trim() !== "");
    if (i === 0) base = "root";
    else if (ownName(node)) base = ownName(node);
    else if (node.tag === "svg") base = "icon";
    else if (node.svg) base = node.tag;
    else if (node.tag === "img") base = "image";
    else if (node.tag === "a") base = "link";
    else if (["input", "textarea", "select", "label", "button", "kbd", "code"].includes(node.tag)) base = node.tag;
    else if (texts.length > 0 && node.children.every((c) => c.text !== undefined)) base = "text";
    if (["root", "hover", "default"].includes(base) && i !== 0) base = `${base}Part`;
    if (/^(variant|interaction)-/.test(base)) base = `part${base}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}${n}`;
  });
}

// A child as the shape sees it: an element, blank space, or text.
function childKind(child) {
  if (child.node !== undefined) return "e";
  if (child.text.trim() === "") return "s";
  return "t";
}

const shapeOf = (nodes) => nodes.map((n) => `${n.tag}:${n.parent}:${n.children.map(childKind).join("")}`).join("|");

function cssBlock(selector, props) {
  const entries = Object.entries(props);
  if (entries.length === 0) return "";
  return `${selector} {\n${entries.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}\n`;
}

// The inherited properties every component root states outright, so it
// reads the same wherever it is placed; the rest it states only where
// they differ from the library app's own.
const ROOT_TYPE = new Set([
  "color", "font-family", "font-size", "font-weight", "font-style", "font-stretch", "font-feature-settings",
  "font-variation-settings", "line-height", "letter-spacing", "word-spacing", "text-align", "text-transform",
  "text-indent", "white-space-collapse", "text-wrap-mode", "-webkit-font-smoothing", "direction", "cursor",
]);

// Colours that only paint when their line or border is drawn: left out
// when it is not, since their value is then just the text colour.
const PAINTED_BY = {
  "border-top-color": (st) => st["border-top-style"] !== "none" && st["border-top-width"] !== "0px",
  "border-right-color": (st) => st["border-right-style"] !== "none" && st["border-right-width"] !== "0px",
  "border-bottom-color": (st) => st["border-bottom-style"] !== "none" && st["border-bottom-width"] !== "0px",
  "border-left-color": (st) => st["border-left-style"] !== "none" && st["border-left-width"] !== "0px",
  "outline-color": (st) => st["outline-style"] !== "none",
  "column-rule-color": (st) => st["column-rule-style"] !== "none",
  "text-decoration-color": (st) => st["text-decoration-line"] !== "none",
  "text-emphasis-color": (st) => st["text-emphasis-style"] !== "none",
  "-webkit-text-stroke-color": (st) => st["-webkit-text-stroke-width"] !== "0px",
  "caret-color": (st, node) => node.tag === "input" || node.tag === "textarea",
  "-webkit-text-fill-color": (st) => st["-webkit-text-fill-color"] !== st.color,
};

/** The properties to write for one element of one instance. */
function propsFor(node, nodes, baseline, declared, isRoot) {
  const out = {};
  const base = baseline[kindOf(node)].style;
  const parent = isRoot ? null : nodes[node.parent];
  for (const [name, value] of Object.entries(node.style)) {
    if (skipped(name)) continue;
    if (name === "transform-origin" || name === "perspective-origin") {
      if (node.style.transform === "none") continue;
    }
    if (PAINTED_BY[name] && !PAINTED_BY[name](node.style, node)) continue;
    if (INHERITED.has(name)) {
      if (isRoot) {
        if (ROOT_TYPE.has(name) || base[name] !== value) out[name] = value;
      } else if (parent.style[name] !== value) out[name] = value;
      continue;
    }
    if (base[name] !== value) out[name] = value;
  }
  for (const name of DECLARED) {
    let value = declared[name];
    if (value === undefined) continue;
    if (isRoot && /^(margin|top|right|bottom|left)/.test(name)) continue;
    // At the root, a value taken from the parent is taken from wherever the component is placed.
    if (isRoot && /^(inherit|unset|initial|revert|revert-layer)$/.test(value)) value = node.style[name];
    // A reset the product and the library app both make (margin: 0) is the app's already.
    if (value === base[name] && node.style[name] === base[name]) continue;
    out[name] = value;
  }
  if (!("line-height" in out) && (isRoot || !parent || parent.style["line-height"] !== node.style["line-height"])) out["line-height"] = node.style["line-height"];
  if (isRoot) {
    if (out.position === "absolute" || out.position === "fixed" || out.position === "sticky") out.position = "relative";
    // An inline root's box is its text; set on its own it would sit in a
    // line box of its own and move. As an inline-block at the text's
    // natural height it keeps that box, and still sits on a baseline.
    if (node.style.display === "inline") {
      out.display = "inline-block";
      out["line-height"] = "normal";
      out["vertical-align"] = "top";
    }
    out["box-sizing"] = node.style["box-sizing"];
  }
  // A pinned size is the box as measured (layoutOf): it says border-box.
  if (declared["box-sizing"]) out["box-sizing"] = declared["box-sizing"];
  return out;
}

function pseudoProps(node, which, baseline) {
  const style = node.pseudo[which];
  const base = baseline[kindOf(node)].pseudo[which] ?? {};
  const out = {};
  for (const [name, value] of Object.entries(style)) {
    if (name === "content") {
      if (which !== "::placeholder") out.content = value;
      continue;
    }
    if (skipped(name) && !["width", "height", "top", "right", "bottom", "left"].includes(name)) continue;
    if (base[name] !== value) out[name] = value;
  }
  if (which !== "::placeholder" && style.display !== "inline") {
    out.width = style.width;
    out.height = style.height;
  }
  return out;
}

/**
 * What a look must say on top of the element's base look: every
 * property it sets differently, and every property the base sets that
 * this look does not, put back to this look's own value (a declared
 * size back to its initial value, anything else to what this look
 * computes).
 */
function diffProps(props, base, node) {
  const out = Object.fromEntries(Object.entries(props).filter(([k, v]) => base[k] !== v));
  for (const name of Object.keys(base)) {
    if (name in props) continue;
    if (name === "line-height" || !DECLARED_SET.has(name)) out[name] = node.style[name];
    else out[name] = "initial";
  }
  return out;
}

/**
 * The same for its pseudo-elements, by which one: what this look's
 * ::before, ::after or ::placeholder sets differently from the base
 * look's, the base's other properties put back to this look's value, the
 * whole pseudo-element where only this look has it, and content: none
 * where only the base has it.
 */
function pseudoDiffs(node, baseNode, baseline) {
  const out = {};
  for (const which of new Set([...Object.keys(baseNode.pseudo), ...Object.keys(node.pseudo)])) {
    if (!(which in node.pseudo)) {
      out[which] = { content: "none" };
      continue;
    }
    const mine = pseudoProps(node, which, baseline);
    if (!(which in baseNode.pseudo)) {
      out[which] = mine;
      continue;
    }
    const base = pseudoProps(baseNode, which, baseline);
    const diff = Object.fromEntries(Object.entries(mine).filter(([k, v]) => base[k] !== v));
    for (const name of Object.keys(base)) if (!(name in mine)) diff[name] = node.pseudo[which][name];
    out[which] = diff;
  }
  return out;
}

/**
 * One element tree for several looks of a component: the first look's
 * elements, with each other look's children matched to them in order
 * (a longest common run of the same kinds of element and text) and the
 * elements only some looks have added where they sit. Each tree node
 * knows which look holds it (`members`: look → element index) and each
 * text which look says what (`texts`: look → string).
 */
function unify(looks) {
  const nodes = [];
  const at = new Map(looks.map((inst) => [inst, new Map()]));
  const itemsOf = (inst, i) => inst.nodes[i].children;
  const keyOfChild = (inst, child) => {
    if (child.node !== undefined) return `e:${inst.nodes[child.node].tag}`;
    if (child.text.trim() === "") return "s";
    return "t";
  };
  const keyOfItem = (item) => {
    if (item.u !== undefined) {
      const [inst, i] = nodes[item.u].members.entries().next().value;
      return `e:${inst.nodes[i].tag}`;
    }
    if (item.texts.values().next().value.trim() === "") return "s";
    return "t";
  };
  const itemFor = (inst, child) => {
    if (child.node !== undefined) return { u: create(inst, child.node) };
    return { texts: new Map([[inst, child.text]]) };
  };
  function create(inst, i) {
    const id = nodes.length;
    const u = { members: new Map([[inst, i]]), items: [] };
    nodes.push(u);
    at.get(inst).set(i, id);
    u.items = itemsOf(inst, i).map((child) => itemFor(inst, child));
    return id;
  }
  function merge(id, inst, i) {
    const u = nodes[id];
    u.members.set(inst, i);
    at.get(inst).set(i, id);
    const mine = itemsOf(inst, i);
    const pairs = lcs(u.items.map(keyOfItem), mine.map((child) => keyOfChild(inst, child)));
    const merged = [];
    let a = 0;
    let b = 0;
    for (const [pa, pb] of [...pairs, [u.items.length, mine.length]]) {
      while (a < pa) merged.push(u.items[a++]);
      while (b < pb) merged.push(itemFor(inst, mine[b++]));
      if (pa === u.items.length) break;
      const theirs = u.items[a++];
      const child = mine[b++];
      if (child.node !== undefined) merge(theirs.u, inst, child.node);
      else theirs.texts.set(inst, child.text);
      merged.push(theirs);
    }
    u.items = merged;
  }
  create(looks[0], 0);
  for (const inst of looks.slice(1)) merge(0, inst, 0);
  return { nodes, at };
}

/** Index pairs of a longest common subsequence of two key lists. */
function lcs(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
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

function main() {
  const [codebase, jsonArg] = process.argv.slice(2);
  if (!codebase || !jsonArg) {
    console.error(USAGE);
    process.exit(1);
  }
  let spec;
  try {
    spec = JSON.parse(jsonArg.startsWith("@") ? readFileSync(jsonArg.slice(1), "utf8") : jsonArg);
  } catch {
    console.error(`the component spec is not JSON: ${USAGE}`);
    process.exit(1);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.slug ?? "") || !spec.name || !Array.isArray(spec.states) || spec.states.length === 0) {
    console.error('the spec needs { "slug", "name", "states": [{ "name", "selector", "force"?, "of"? }, …] }');
    process.exit(1);
  }
  for (const state of spec.states) {
    if (!state.name || !state.selector) {
      console.error("every state needs a name and a selector");
      process.exit(1);
    }
    if (state.force && !FORCEABLE.includes(state.force)) {
      console.error(`force is one of ${FORCEABLE.join(", ")}`);
      process.exit(1);
    }
  }
  if (spec.states[0].force) {
    console.error("the first state is the default: it cannot hold a pseudo-class");
    process.exit(1);
  }
  return run(codebase, spec);
}

async function run(codebase, spec) {
  const home = join(process.env.HOME ?? "", ".proto", codebase);
  const library = join(home, "library");
  const folder = join(library, "src", "components", spec.slug);
  const liveUrl = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source?.liveUrl;
  const port = JSON.parse(readFileSync(join(home, "run", "library", "tunnel.json"), "utf8")).port;
  const appUrl = `http://localhost:${port}`;
  const page = new URL(liveUrl);
  const tab = await findPage(`${page.host}${page.pathname}`);
  if (!tab) throw new Error("the product page is not open in the Proto window");
  const live = await connect(tab.webSocketDebuggerUrl);
  const Name = pascal(spec.slug);

  let instances;
  let faces;
  let viewport;
  let display;
  try {
    const [width, height] = await evaluate(live, "[innerWidth, innerHeight]");
    viewport = { width, height };
    display = await displayOf(live);
    instances = [];
    for (const state of spec.states) {
      // Read under the window's lock: another lane's held hover must not show in it.
      const read = await withForcedState(live, state.selector, state.force, async () => {
        const data = await evaluate(live, `(${READ_INSTANCE})(${JSON.stringify(state.selector)})`);
        if (!data) throw new Error(`nothing on the live page matches ${state.selector} (state ${state.name})`);
        return data;
      });
      const inst = { state, ...read, fit: read.nodes.map(() => ({})) };
      inst.declared = inst.nodes.map((node, i) => layoutOf(node, inst.nodes, inst.fit[i], i === 0, inst.room));
      instances.push(inst);
    }
    faces = await fontFaces(live);
  } finally {
    live.close();
  }

  // A held state is its look with a pseudo-class on: it shares that look's fitted sizes.
  for (const inst of instances.filter((x) => x.state.force)) {
    const of = inst.state.of ? instances.find((x) => x.state.name === inst.state.of) : instances[0];
    if (of && of.nodes.length === inst.nodes.length) inst.fit = of.fit;
  }

  // The app's base under each kind of element any instance holds.
  const kinds = [...new Set(instances.flatMap((inst) => inst.nodes.map(kindOf)))];
  const baseline = await appBaseline(appUrl, kinds, viewport, display);

  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });

  // Fonts: every face of every family the component's text uses.
  const families = new Set(instances.flatMap((inst) => inst.nodes.flatMap((n) => familiesIn(n.style["font-family"] ?? ""))));
  const fontCss = [];
  const fontFiles = new Map();
  for (const face of faces.filter((f) => families.has(f.family))) {
    let body = face.body;
    for (const match of face.body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (match[1].startsWith("data:")) continue;
      const absolute = new URL(match[1], face.base ?? instances[0].base).toString();
      let file = fontFiles.get(absolute);
      if (!file) {
        file = fileNameOf(absolute, `font${fontFiles.size + 1}.woff2`);
        if ([...fontFiles.values()].includes(file)) file = `${fontFiles.size + 1}-${file}`;
        await download(absolute, join(folder, file));
        fontFiles.set(absolute, file);
      }
      body = body.replace(match[0], `url("./${file}")`);
    }
    fontCss.push(`@font-face {\n  ${body.trim().replace(/;\s*/g, ";\n  ").replace(/\n  $/, "")}\n}\n`);
  }

  // Images: an <img> becomes an imported file beside the module.
  const images = new Map();
  for (const inst of instances) {
    for (const node of inst.nodes) {
      if (node.tag !== "img" || !node.attrs.src) continue;
      const absolute = new URL(node.attrs.src, inst.base).toString();
      if (images.has(absolute)) continue;
      const ident = `image${images.size + 1}`;
      let file;
      // An inline image (a data: URL) is written out as the file it holds,
      // so it is imported like any other and chosen by look the same way.
      if (absolute.startsWith("data:")) {
        const inline = inlineImage(absolute);
        file = `${ident}.${inline.extension}`;
        writeFileSync(join(folder, file), inline.bytes);
      } else {
        file = `${ident}${/\.(svg|png|jpe?g|webp|gif|avif)$/i.exec(new URL(absolute).pathname)?.[0] ?? ".png"}`;
        await download(absolute, join(folder, file));
      }
      images.set(absolute, { file, ident });
    }
  }
  const imageOf = (node, inst) => images.get(new URL(node.attrs.src, inst.base).toString());

  // Everything below is written again after each round of fitting sizes.
  const emit = () => {
  // ---- one tree for every look: the default's elements, plus any a variant adds ----
  const defaultInst = instances[0];
  const variants = instances.filter((inst) => !inst.state.force);
  const interactions = instances.filter((inst) => inst.state.force);
  // Each look's key for the `variant` prop: the first is "default", the
  // rest from their names, never two alike (a later look the product
  // also calls "Default" becomes "default-2").
  const lookKeys = new Map();
  for (const inst of instances.filter((x) => !x.state.force)) {
    let key = inst === defaultInst ? "default" : keyOf(inst.state.name);
    for (let n = 2; [...lookKeys.values()].includes(key); n++) key = `${keyOf(inst.state.name)}-${n}`;
    lookKeys.set(inst, key);
  }
  const variantKey = (inst) => lookKeys.get(inst);
  const ofOf = (inst) => {
    if (!inst.state.of) return defaultInst;
    const of = instances.find((x) => x.state.name === inst.state.of);
    if (!of || of.state.force) throw new Error(`${inst.state.name}: "of" must name a state without a pseudo-class`);
    return of;
  };
  const tree = unify(variants);
  for (const inst of interactions) {
    const of = ofOf(inst);
    if (shapeOf(inst.nodes) !== shapeOf(of.nodes)) {
      throw new Error(`${inst.state.name} changes which elements ${of.state.name} has; hold the pseudo-class on an instance whose elements stay put`);
    }
    tree.at.set(inst, tree.at.get(of));
  }
  const baseOf = (u) => {
    const [inst, i] = u.members.entries().next().value;
    return { inst, i };
  };
  const names = nameNodes(tree.nodes.map((u) => {
    const { inst, i } = baseOf(u);
    return inst.nodes[i];
  }));
  const propsAt = (inst, i) => propsFor(inst.nodes[i], inst.nodes, baseline, inst.declared[i], i === 0);

  const css = [];
  const baseProps = tree.nodes.map((u) => {
    const { inst, i } = baseOf(u);
    return propsAt(inst, i);
  });
  tree.nodes.forEach((u, id) => {
    const { inst, i } = baseOf(u);
    css.push(cssBlock(`.${names[id]}`, baseProps[id]));
    for (const which of Object.keys(inst.nodes[i].pseudo)) css.push(cssBlock(`.${names[id]}${which}`, pseudoProps(inst.nodes[i], which, baseline)));
  });
  // Variants: only what differs from the element's base look, under the root's variant class.
  for (const inst of variants) {
    const key = `variant-${variantKey(inst)}`;
    for (const [i, id] of tree.at.get(inst)) {
      if (baseOf(tree.nodes[id]).inst === inst) continue;
      const props = diffProps(propsAt(inst, i), baseProps[id], inst.nodes[i]);
      const selector = id === 0 ? `.root.${key}` : `.root.${key} .${names[id]}`;
      css.push(cssBlock(selector, props));
      const { inst: baseInst, i: baseI } = baseOf(tree.nodes[id]);
      for (const [which, own] of Object.entries(pseudoDiffs(inst.nodes[i], baseInst.nodes[baseI], baseline))) css.push(cssBlock(`${selector}${which}`, own));
    }
  }
  // Interactions: the pseudo-class and the forced class share one rule.
  for (const inst of interactions) {
    const of = ofOf(inst);
    const pseudo = inst.state.force;
    // Scoped to its look whenever there are several: the first look's
    // hover must not land on the others (they only say how theirs differ
    // from their own rest).
    const variantClass = variants.length > 1 ? `.variant-${variantKey(of)}` : "";
    for (const [i, id] of tree.at.get(of)) {
      const props = diffProps(propsAt(inst, i), propsAt(of, i), inst.nodes[i]);
      const tail = id === 0 ? "" : ` .${names[id]}`;
      const selectors = [`.root${variantClass}:${pseudo}${tail}`, `.root${variantClass}.interaction-${pseudo}${tail}`];
      css.push(cssBlock(selectors.join(",\n"), props));
      for (const [which, own] of Object.entries(pseudoDiffs(inst.nodes[i], of.nodes[i], baseline))) {
        css.push(cssBlock(selectors.map((selector) => `${selector}${which}`).join(",\n"), own));
      }
    }
  }

  // ---- texts: the first becomes children; others that differ between looks become props ----
  const textItems = [];
  // Text inside an icon (an SVG's <title>) is part of the icon, never a prop.
  const walk = (id) => {
    const { inst, i } = baseOf(tree.nodes[id]);
    if (inst.nodes[i].svg) return;
    tree.nodes[id].items.forEach((item, k) => {
      if (item.u !== undefined) walk(item.u);
      else if ([...item.texts.values()].some((t) => t.trim() !== "")) textItems.push({ id, k, item });
    });
  };
  walk(0);
  const everywhere = (present) => variants.every((inst) => present.has(inst));
  // The first text is `children`; any other text whose words differ
  // between the looks that show it is a prop, so every look says its own
  // words (a label only two looks have is still theirs, not the first's).
  const slots = new Map();
  let first = true;
  for (const { item } of textItems) {
    const texts = variants.filter((inst) => item.texts.has(inst)).map((inst) => item.texts.get(inst));
    if (first) {
      slots.set(item, { prop: "children", default: texts[0] });
      first = false;
    } else if (new Set(texts).size > 1) slots.set(item, { prop: `text${slots.size + 1}`, default: texts[0] });
  }
  const valueSlot = defaultInst.nodes.findIndex((n) => n.value !== null && n.value !== "");

  // Attributes whose value differs between the looks that have the
  // element (a field's placeholder, a link's address, an image's file)
  // are the look's own, like its words: a prop, or for an image its file
  // chosen by look.
  const taken = new Set(["children", "value", "variant", "interaction", ...[...slots.values()].map((slot) => slot.prop)]);
  // A slot is "string" (a look without the attribute holds null, so it
  // is not given the first look's value) or "boolean" (the attribute's
  // presence is its value: a disabled button, a ticked box).
  const attrSlots = new Map(); // `${id}:${attr}` → { prop, kind, default, byLook }
  const imageChoices = new Map(); // id → { name, byLook: Map(key → ident), fallback }
  tree.nodes.forEach((u, id) => {
    const looks = variants.filter((inst) => u.members.has(inst));
    const node0 = baseOf(u).inst.nodes[baseOf(u).i];
    const names = new Set(looks.flatMap((inst) => Object.keys(inst.nodes[u.members.get(inst)].attrs)));
    for (const name of names) {
      const kind = name in BOOLEAN_ATTRS ? "boolean" : "string";
      const attrIn = (inst) => inst.nodes[u.members.get(inst)].attrs[name];
      const valueIn = (inst) => {
        if (kind === "boolean") return attrIn(inst) !== undefined;
        return attrIn(inst) ?? null;
      };
      if (new Set(looks.map(valueIn)).size < 2) continue;
      if (node0.tag === "img" && name === "src") {
        const byLook = new Map();
        for (const inst of looks) {
          const img = imageOf(inst.nodes[u.members.get(inst)], inst);
          if (img) byLook.set(variantKey(inst), img.ident);
        }
        imageChoices.set(id, { name: `imageFor${id}`, byLook, fallback: byLook.values().next().value });
        continue;
      }
      const jsxName = jsxAttr(name, node0);
      if (!jsxName) continue;
      // A button is always written type="button" (it never submits a form), whatever the product's.
      if (name === "type" && node0.tag === "button") continue;
      const base = jsxName.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let prop = base;
      for (let n = 2; taken.has(prop); n++) prop = `${base}${n}`;
      taken.add(prop);
      const byLook = new Map(looks.map((inst) => [inst, valueIn(inst)]));
      attrSlots.set(`${id}:${name}`, { prop, kind, default: valueIn(looks[0]), byLook });
    }
  });

  // ---- JSX ----
  const lines = [];
  const indent = (d) => "  ".repeat(d);
  const onlyIn = (present) => {
    if (everywhere(present)) return null;
    return variants.filter((inst) => present.has(inst)).map((inst) => `variant === ${JSON.stringify(variantKey(inst))}`).join(" || ");
  };
  const sameLooks = (a, b) => a.size === b.size && [...a.keys()].every((k) => b.has(k));
  const renderU = (id, depth, parentLooks) => {
    const u = tree.nodes[id];
    const { inst, i } = baseOf(u);
    const node = inst.nodes[i];
    const condition = id === 0 || sameLooks(u.members, parentLooks) ? null : onlyIn(u.members);
    const d = condition ? depth + 1 : depth;
    if (condition) lines.push(`${indent(depth)}{(${condition}) && (`);
    const attrs = [];
    if (id === 0) attrs.push("className={cx(styles.root, styles[`variant-${variant}`], interaction === \"rest\" ? undefined : styles[`interaction-${interaction}`])}");
    else attrs.push(`className={styles[${JSON.stringify(names[id])}]}`);
    const attrNames = new Set([...u.members.entries()].filter(([look]) => variants.includes(look)).flatMap(([look, k]) => Object.keys(look.nodes[k].attrs)));
    for (const name of attrNames) {
      const value = node.attrs[name];
      const jsxName = jsxAttr(name, node);
      if (!jsxName) continue;
      if (node.tag === "img" && name === "src") {
        const choice = imageChoices.get(id);
        const img = value !== undefined ? imageOf(node, inst) : undefined;
        if (choice) attrs.push(`src={${choice.name}[variant] ?? ${choice.fallback}}`);
        else if (img) attrs.push(`src={${img.ident}}`);
        continue;
      }
      const slot = attrSlots.get(`${id}:${name}`);
      if (slot) {
        // null is the product's absence; React's attribute types take undefined for it.
        if (slot.kind === "boolean") attrs.push(`${BOOLEAN_ATTRS[name]}={${slot.prop}}`);
        else attrs.push(`${jsxName}={${slot.prop} ?? undefined}`);
        continue;
      }
      if (value === undefined) continue;
      if (name === "type" && node.tag === "button") {
        attrs.push(`type="button"`);
        continue;
      }
      if (name in BOOLEAN_ATTRS) {
        attrs.push(BOOLEAN_ATTRS[name]);
        continue;
      }
      // As an expression, like a text child: a quoted JSX attribute reads
      // backslashes literally, so a JSON string there is not the same string.
      attrs.push(`${jsxName}={${JSON.stringify(value)}}`);
    }
    if (node.tag === "button" && !("type" in node.attrs)) attrs.push(`type="button"`);
    if (id === 0 && valueSlot === 0) attrs.push(`defaultValue={value}`);
    if (id !== 0 && inst === defaultInst && i === valueSlot) attrs.push(`defaultValue={value}`);
    if (node.tag === "input" || node.tag === "textarea") attrs.push("readOnly");
    const open = `<${node.tag} ${attrs.join(" ")}`;
    const kids = u.items.filter((item) => item.u !== undefined || [...item.texts.values()].some((t) => t !== ""));
    if (kids.length === 0) lines.push(`${indent(d)}${open} />`);
    else {
      lines.push(`${indent(d)}${open}>`);
      const flexParent = /flex|grid/.test(node.style.display);
      for (const item of u.items) {
        if (item.u !== undefined) {
          renderU(item.u, d + 1, u.members);
          continue;
        }
        const sample = item.texts.values().next().value;
        const when = sameLooks(item.texts, u.members) ? null : onlyIn(item.texts);
        let expr;
        if (sample.trim() === "") {
          if (flexParent || sample === "" || node.svg) continue;
          expr = `" "`;
        } else if (slots.has(item)) expr = slots.get(item).prop;
        else expr = JSON.stringify(sample);
        if (when) lines.push(`${indent(d + 1)}{(${when}) && ${expr}}`);
        else lines.push(`${indent(d + 1)}{${expr}}`);
      }
      lines.push(`${indent(d)}</${node.tag}>`);
    }
    if (condition) lines.push(`${indent(depth)})}`);
  };
  renderU(0, 2, tree.nodes[0].members);

  const variantKeys = variants.map(variantKey);
  const interactionKeys = ["rest", ...new Set(interactions.map((inst) => inst.state.force))];
  const propDocs = [];
  const destructure = [];
  for (const slot of slots.values()) {
    propDocs.push(`  /** ${JSON.stringify(slot.default)} in the product. */\n  ${slot.prop}?: ${slot.prop === "children" ? "ReactNode" : "string"};`);
    destructure.push(`${slot.prop} = ${JSON.stringify(slot.default)}`);
  }
  // An attribute the first look does not have defaults to null (or false), so React leaves it out.
  for (const slot of attrSlots.values()) {
    if (slot.kind === "boolean") {
      propDocs.push(`  /** ${slot.default ? "Set" : "Not set"} in the product's first look. */\n  ${slot.prop}?: boolean;`);
    } else if (slot.default === null) {
      propDocs.push(`  /** Not set in the product's first look. */\n  ${slot.prop}?: string | null;`);
    } else {
      propDocs.push(`  /** ${JSON.stringify(slot.default)} in the product's first look; null for none. */\n  ${slot.prop}?: string | null;`);
    }
    destructure.push(`${slot.prop} = ${JSON.stringify(slot.default)}`);
  }
  if (valueSlot !== -1) {
    propDocs.push(`  /** What the field holds, ${JSON.stringify(defaultInst.nodes[valueSlot].value)} in the product. */\n  value?: string;`);
    destructure.push(`value = ${JSON.stringify(defaultInst.nodes[valueSlot].value)}`);
  }
  propDocs.push(`  /** Which of the product's looks: ${variantKeys.map((k) => JSON.stringify(k)).join(", ")}. */\n  variant?: ${Name}Variant;`);
  destructure.push(`variant = "default"`);
  propDocs.push(`  /** A pointer or focus look, held without a pointer; "rest" is neither. */\n  interaction?: ${Name}Interaction;`);
  destructure.push(`interaction = "rest"`);

  const tsx = `import type { ReactNode } from "react";
import styles from "./${Name}.module.css";
${[...images.values()].map((img) => `import ${img.ident} from "./${img.file}";`).join("\n")}

/**
 * ${spec.name}, as the product renders it (${defaultInst.base.split("?")[0]}).
 * Written by tools/snapshot.mjs from the live page; notes.md says where
 * each value came from.
 */
export type ${Name}Variant = ${variantKeys.map((k) => JSON.stringify(k)).join(" | ")};
export type ${Name}Interaction = ${interactionKeys.map((k) => JSON.stringify(k)).join(" | ")};

export interface ${Name}Props {
${propDocs.join("\n")}
}

const cx = (...names: (string | undefined)[]) => names.filter(Boolean).join(" ");
${[...imageChoices.values()].map((c) => `const ${c.name}: Partial<Record<${Name}Variant, string>> = { ${[...c.byLook].map(([k, ident]) => `${JSON.stringify(k)}: ${ident}`).join(", ")} };`).join("\n")}

export default function ${Name}({ ${destructure.join(", ")} }: ${Name}Props) {
  return (
${lines.join("\n")}
  );
}
`;
  writeFileSync(join(folder, `${Name}.tsx`), tsx.replace(/\n\n\n+/g, "\n\n"));
  writeFileSync(join(folder, `${Name}.module.css`), [...fontCss, ...css].filter(Boolean).join("\n"));

  // ---- component.json ----
  const states = instances.map((inst) => {
    const props = {};
    const look = inst.state.force ? ofOf(inst) : inst;
    if (inst.state.force) props.interaction = inst.state.force;
    if (look !== defaultInst) props.variant = variantKey(look);
    for (const [item, slot] of slots) {
      const text = item.texts.get(look);
      if (text !== undefined && text !== slot.default) props[slot.prop] = text;
    }
    // Only looks that have the element say anything; null or false where theirs has no such attribute.
    for (const slot of attrSlots.values()) {
      if (!slot.byLook.has(look)) continue;
      const value = slot.byLook.get(look);
      if (value !== slot.default) props[slot.prop] = value;
    }
    const live = { selector: inst.state.selector };
    if (inst.state.force) live.force = inst.state.force;
    return { name: inst.state.name, props, live };
  });
  const unit = { states, tokens: [] };
  if (defaultInst.backdrop) unit.backdrop = defaultInst.backdrop;
  writeFileSync(join(folder, "component.json"), JSON.stringify(unit, null, 2) + "\n");
  return { states, defaultInst, variants };
  };

  // ---- sizes: fitted against the product, look by look ----
  let { states, defaultInst, variants } = emit();
  for (let round = 0; round < 3; round++) {
    const changed = await fitSizes(appUrl, spec.slug, variants, states, viewport, display);
    if (!changed) break;
    for (const inst of instances) inst.declared = inst.nodes.map((node, i) => layoutOf(node, inst.nodes, inst.fit[i], i === 0, inst.room));
    ({ states, defaultInst, variants } = emit());
  }
  const tokens = await matchTokens(library, instances, appUrl, viewport, display);
  const unit = { states, tokens };
  if (defaultInst.backdrop) unit.backdrop = defaultInst.backdrop;
  writeFileSync(join(folder, "component.json"), JSON.stringify(unit, null, 2) + "\n");

  // ---- notes.md ----
  const notes = [
    `# ${spec.name}`,
    "",
    `Written by tools/snapshot.mjs on ${new Date().toISOString()} from ${defaultInst.base.split("?")[0]}.`,
    "",
    "Every value in the stylesheet is the live element's computed style; a value equal to the library app's own base for that element is left out. Widths and heights are left to the layout and pinned only where the component, rendered on its own, came out a different size from the product (100% where the product's box fills its parent, else its size); equal grid tracks that fill their container are written as fractions.",
    "",
    "## States and where they were read",
    "",
    ...instances.map((inst) => `- ${inst.state.name}: \`${inst.state.selector}\`${inst.state.force ? ` with :${inst.state.force} held` : ""}`),
    "",
    `Backdrop: ${defaultInst.backdrop ?? "none (the component paints its own)"}, the product's painted ancestors composited.`,
    "",
    `Fonts: ${[...fontFiles.values()].join(", ") || "none beyond the system's"}, from the page's @font-face rules.`,
    "",
  ].join("\n");
  writeFileSync(join(folder, "notes.md"), notes);

  return {
    slug: spec.slug,
    module: `src/components/${spec.slug}/${Name}.tsx`,
    states: states.map((s) => s.name),
    tokens,
    backdrop: defaultInst.backdrop,
    nodes: defaultInst.nodes.length,
    fonts: [...fontFiles.values()],
    images: [...images.values()].map((i) => i.file),
  };
}

// The SVG elements that paint; the svg and g around them only pass colours down.
const SHAPES = ["path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "use"];

/** The manifest's palette colours the component paints with, compared as the display draws them. */
async function matchTokens(library, instances, appUrl, viewport, display) {
  const manifestPath = join(library, "public", "manifest.json");
  if (!existsSync(manifestPath)) return [];
  const tokens = JSON.parse(readFileSync(manifestPath, "utf8")).tokens ?? [];
  if (tokens.length === 0) return [];
  const used = new Set();
  for (const inst of instances) {
    for (const node of inst.nodes) {
      const hasText = node.children.some((c) => c.text !== undefined && c.text.trim() !== "");
      for (const name of ["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "text-decoration-color", "caret-color"]) {
        // Only colours something is painted with: text colour where there
        // is text, fill and stroke on an icon, a border where it is drawn.
        if (name === "color" && !hasText && !node.svg) continue;
        if ((name === "fill" || name === "stroke") && !SHAPES.includes(node.tag)) continue;
        if (PAINTED_BY[name] && !PAINTED_BY[name](node.style, node)) continue;
        const value = node.style[name];
        if (value && !/^(none|transparent|currentcolor)$/i.test(value) && !/rgba\(0, 0, 0, 0\)/.test(value)) used.add(value);
      }
    }
  }
  const page = await headlessPage(`${appUrl}/#/render/__baseline__/none`, { ...viewport, display });
  try {
    return await evaluate(
      page.page,
      `(${String.raw`(tokens, used) => {
        const c = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
        const read = (value) => { c.clearRect(0, 0, 1, 1); c.fillStyle = '#00000000'; c.fillStyle = value; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data]; };
        const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
        const colours = used.map(read);
        return tokens.filter((t) => { const px = read(t.value); return px[3] > 0 && colours.some((u) => near(u, px)); }).map((t) => t.name);
      }`})(${JSON.stringify(tokens.map((t) => ({ name: t.name, value: t.value })))}, ${JSON.stringify([...used])})`,
    );
  } finally {
    await page.close();
  }
}

// A snapshot that cannot finish says so; it never hangs the import behind it.
setTimeout(() => {
  console.error("the component could not be written within 90 s (the page or the library app stopped answering); try it again");
  process.exit(2);
}, 90_000).unref();

try {
  const result = await main();
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
