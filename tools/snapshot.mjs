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
 *   - sizes, margins, offsets and grid tracks from the product's own
 *     declared rules (CSS.getMatchedStylesForNode), variables resolved,
 *     rem converted, so a width of 100% stays a width of 100% instead of
 *     freezing to the pixels it came to on this page;
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

// Sizes, margins, offsets and grid tracks: taken from the product's
// declared rules, never from the computed style (which is the pixels
// they came to on this page).
const DECLARED = [
  "width", "height", "min-width", "min-height", "max-width", "max-height", "flex-basis",
  "top", "right", "bottom", "left",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "grid-template-columns", "grid-template-rows", "grid-auto-columns", "grid-auto-rows",
  "line-height",
];
const DECLARED_SET = new Set(DECLARED);
// Shorthands and logical names, as the product may declare them (left-to-right pages).
const EXPANDS = {
  margin: ["margin-top", "margin-right", "margin-bottom", "margin-left"],
  "margin-inline": ["margin-left", "margin-right"],
  "margin-block": ["margin-top", "margin-bottom"],
  "margin-inline-start": ["margin-left"],
  "margin-inline-end": ["margin-right"],
  "margin-block-start": ["margin-top"],
  "margin-block-end": ["margin-bottom"],
  inset: ["top", "right", "bottom", "left"],
  "inset-inline": ["left", "right"],
  "inset-block": ["top", "bottom"],
  "inset-inline-start": ["left"],
  "inset-inline-end": ["right"],
  "inset-block-start": ["top"],
  "inset-block-end": ["bottom"],
  "inline-size": ["width"],
  "block-size": ["height"],
  "min-inline-size": ["min-width"],
  "min-block-size": ["min-height"],
  "max-inline-size": ["max-width"],
  "max-block-size": ["max-height"],
  "grid-template": ["grid-template-rows", "grid-template-columns"],
};

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
    const tag = el.tagName.toLowerCase();
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
  return {
    nodes, backdrop,
    rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize),
    base: location.href,
  };
}`;

/** Resolve var() against each element's own custom properties, and rem against the page's root size. */
const RESOLVE = String.raw`(rootSelector, items, rootFontSize) => {
  const root = document.querySelector(rootSelector);
  const elements = [root, ...root.querySelectorAll('*')];
  const resolve = (el, text, depth) => {
    if (depth > 12) return text;
    const out = text.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (all, name, fallback) => {
      const value = getComputedStyle(el).getPropertyValue(name).trim();
      if (value !== '') return value;
      return fallback !== undefined ? fallback.trim() : all;
    });
    if (out !== text && /var\(/.test(out)) return resolve(el, out, depth + 1);
    return out;
  };
  return items.map(({ i, text }) => resolve(elements[i], text, 0).replace(/(-?\d*\.?\d+)rem\b/g, (_, n) => +(parseFloat(n) * rootFontSize).toFixed(4) + 'px'));
}`;

/** The product's declared value for each DECLARED property of each element, by cascade order. */
async function declaredValues(live, rootSelector, count) {
  await live.send("DOM.enable");
  await live.send("CSS.enable");
  const { root } = await live.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await live.send("DOM.querySelector", { nodeId: root.nodeId, selector: rootSelector });
  const { nodeIds } = await live.send("DOM.querySelectorAll", { nodeId, selector: "*" });
  const ids = [nodeId, ...nodeIds];
  if (ids.length !== count) throw new Error(`the component changed while it was read (${ids.length} elements, then ${count}); read it again`);
  return Promise.all(
    ids.map(async (id) => {
      const matched = await live.send("CSS.getMatchedStylesForNode", { nodeId: id });
      const winners = {};
      const consider = (style) => {
        for (const property of style?.cssProperties ?? []) {
          if (property.disabled || property.parsedOk === false || property.value === undefined) continue;
          const names = EXPANDS[property.name] ?? (DECLARED_SET.has(property.name) ? [property.name] : []);
          if (names.length === 0) continue;
          const important = property.important === true;
          const parts = splitBox(property.value, property.name, names.length);
          names.forEach((name, k) => {
            const previous = winners[name];
            if (previous && previous.important && !important) return;
            winners[name] = { value: parts[k], important };
          });
        }
      };
      for (const match of matched.matchedCSSRules ?? []) {
        if (match.rule.origin === "user-agent") continue;
        consider(match.rule.style);
      }
      consider(matched.inlineStyle);
      const out = {};
      for (const [name, winner] of Object.entries(winners)) out[name] = winner.value.replace(/\s*!important\s*$/, "");
      return out;
    }),
  );
}

// A box shorthand's value for each of its longhands (margin: 0 auto → 0, auto, 0, auto).
function splitBox(value, name, count) {
  if (count === 1) return [value];
  const tokens = [];
  let depth = 0;
  let current = "";
  for (const ch of value.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === " " && depth === 0) {
      if (current) tokens.push(current);
      current = "";
    } else current += ch;
  }
  if (current) tokens.push(current);
  if (name === "grid-template") {
    const [rows, cols] = value.split("/");
    return [rows?.trim() ?? value, cols?.trim() ?? "none"];
  }
  if (count === 2) return [tokens[0], tokens[1] ?? tokens[0]];
  const [t, r = t, b = t, l = r] = tokens;
  return [t, r, b, l];
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

// ---- writing the component ----

const pascal = (slug) => slug.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const keyOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";

const SVG_KEEP_KEBAB = /^(data-|aria-)/;
const HTML_ATTRS = {
  class: null, style: null, for: "htmlFor", tabindex: "tabIndex", readonly: "readOnly", maxlength: "maxLength",
  autocomplete: "autoComplete", spellcheck: "spellCheck", autofocus: null, contenteditable: "contentEditable",
  "xlink:href": "xlinkHref", "xmlns:xlink": "xmlnsXlink", "xml:space": "xmlSpace", colspan: "colSpan", rowspan: "rowSpan",
};

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
      const read = await withForcedState(live, state.selector, state.force, async () => {
        const data = await evaluate(live, `(${READ_INSTANCE})(${JSON.stringify(state.selector)})`);
        if (!data) throw new Error(`nothing on the live page matches ${state.selector} (state ${state.name})`);
        const declared = await declaredValues(live, state.selector, data.nodes.length);
        return { ...data, declared };
      });
      const items = [];
      read.declared.forEach((values, i) => {
        for (const [name, text] of Object.entries(values)) items.push({ i, name, text });
      });
      const resolved = await evaluate(live, `(${RESOLVE})(${JSON.stringify(state.selector)}, ${JSON.stringify(items.map(({ i, text }) => ({ i, text })))}, ${read.rootFontSize})`);
      items.forEach((item, k) => {
        read.declared[item.i][item.name] = resolved[k];
      });
      instances.push({ state, ...read });
    }
    faces = await fontFaces(live);
  } finally {
    live.close();
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
      if (node.tag !== "img" || !node.attrs.src || node.attrs.src.startsWith("data:")) continue;
      const absolute = new URL(node.attrs.src, inst.base).toString();
      if (images.has(absolute)) continue;
      const file = `image${images.size + 1}${/\.(svg|png|jpe?g|webp|gif|avif)$/i.exec(new URL(absolute).pathname)?.[0] ?? ".png"}`;
      await download(absolute, join(folder, file));
      images.set(absolute, { file, ident: `image${images.size + 1}` });
    }
  }
  const imageOf = (node, inst) => images.get(new URL(node.attrs.src, inst.base).toString());

  // ---- one tree for every look: the default's elements, plus any a variant adds ----
  const defaultInst = instances[0];
  const variants = instances.filter((inst) => !inst.state.force);
  const interactions = instances.filter((inst) => inst.state.force);
  const variantKey = (inst) => (inst === defaultInst ? "default" : keyOf(inst.state.name));
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
    }
  }
  // Interactions: the pseudo-class and the forced class share one rule.
  for (const inst of interactions) {
    const of = ofOf(inst);
    const pseudo = inst.state.force;
    const variantClass = of === defaultInst ? "" : `.variant-${variantKey(of)}`;
    for (const [i, id] of tree.at.get(of)) {
      const props = diffProps(propsAt(inst, i), propsAt(of, i), inst.nodes[i]);
      const tail = id === 0 ? "" : ` .${names[id]}`;
      const selectors = [`.root${variantClass}:${pseudo}${tail}`, `.root${variantClass}.interaction-${pseudo}${tail}`];
      css.push(cssBlock(selectors.join(",\n"), props));
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
    for (const [name, value] of Object.entries(node.attrs)) {
      const jsxName = jsxAttr(name, node);
      if (!jsxName) continue;
      if (node.tag === "img" && name === "src") {
        const img = imageOf(node, inst);
        if (img) attrs.push(`src={${img.ident}}`);
        continue;
      }
      if (name === "type" && node.tag === "button") {
        attrs.push(`type="button"`);
        continue;
      }
      if (name === "checked") {
        attrs.push("defaultChecked");
        continue;
      }
      if (name === "disabled") {
        attrs.push("disabled");
        continue;
      }
      attrs.push(`${jsxName}=${JSON.stringify(value)}`);
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
    const live = { selector: inst.state.selector };
    if (inst.state.force) live.force = inst.state.force;
    return { name: inst.state.name, props, live };
  });
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
    "Every value in the stylesheet is the live element's computed style, except sizes, margins, offsets, grid tracks and line heights, which are the product's own declared values (CSS.getMatchedStylesForNode, variables resolved, rem at the page's root size). A value equal to the library app's own base for that element is left out.",
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

/** The manifest's palette colours the component paints with, compared as the display draws them. */
async function matchTokens(library, instances, appUrl, viewport, display) {
  const manifestPath = join(library, "public", "manifest.json");
  if (!existsSync(manifestPath)) return [];
  const tokens = JSON.parse(readFileSync(manifestPath, "utf8")).tokens ?? [];
  if (tokens.length === 0) return [];
  const used = new Set();
  for (const inst of instances) {
    for (const node of inst.nodes) {
      for (const name of ["color", "background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "outline-color", "fill", "stroke", "text-decoration-color", "caret-color"]) {
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

try {
  const result = await main();
  console.log(JSON.stringify(result));
  process.exit(0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
