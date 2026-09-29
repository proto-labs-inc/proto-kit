#!/usr/bin/env node
/**
 * Read the product page once for everything an import decides from:
 * the page itself, its colours, its type styles and the components it
 * shows, with a selector and a picture for each. One call; the Proto
 * window is read, never changed.
 *
 * Usage: node tools/survey.mjs <codebase> [--out <dir>]
 *
 * Prints a summary (the page, the counts, and the draft one component a
 * line with its looks and picture) and writes <out>/survey.json with:
 *   page:       { title, url, favicon, viewport: [w, h], display }
 *   palette:    [{ name, value, group, role? }]   the colours to import,
 *               ready for `library.mjs tokens`: every colour the page
 *               paints with plus every colour of the families those
 *               belong to (background, foreground, border, brand, …),
 *               one name per distinct colour (the most descriptive),
 *               values readable (a formula the page computes becomes
 *               the colour it computes to); role "surface"/"text" on
 *               the page's background and text
 *   colours:    how many colour properties the page defines, for the record
 *   type:       [{ name, family, size, weight, lineHeight, letterSpacing?,
 *                 textTransform?, sample, uses }]   every distinct type
 *               style on visible text, most used first
 *   candidates: [{ id, kind, label, count, instances: [{ selector, rect,
 *                 text, cut }], looks }]   elements grouped by how they
 *               look (tag, role, size, fill, border, type); the first
 *               instance is the best one to read (whole on screen,
 *               largest); `looks` counts distinct looks inside the group
 *   draft:      <out>/plan.draft.json, a plan for tools/import.mjs with every
 *               candidate as a component (placeholder names from kind and
 *               text), one state per look, Hover and Focus on interactive
 *               ones: the orchestrator renames, merges, drops and adds
 *   pictures:   written to <out>/<id>.png (default ~/.proto/<codebase>/run/survey),
 *               each candidate's first instance cropped to its own box
 *               at 2x from one screenshot of the page
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPage } from "./cdp/attach.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { displayOf, headlessPage } from "./cdp/headless.mjs";
import { cropPng, decodePng, encodePng, scalePng } from "./cdp/png.mjs";

const options = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [codebase] = positional;
if (!codebase) {
  console.error("usage: node tools/survey.mjs <codebase> [--out <dir>]");
  process.exit(1);
}
const home = join(process.env.HOME ?? "", ".proto", codebase);
const liveUrl = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source?.liveUrl;
if (!liveUrl) {
  console.error(`${home}/codebase.json has no source.liveUrl: the product page setup opened in the Proto window`);
  process.exit(1);
}
const out = options.out ?? join(home, "run", "survey");
mkdirSync(out, { recursive: true });

const target = new URL(liveUrl);
const tab = await findPage(`${target.host}${target.pathname}`);
if (!tab) {
  console.error("the product page is not open in the Proto window");
  process.exit(1);
}
const live = await connect(tab.webSocketDebuggerUrl);

// ---- custom property names, from the page's own stylesheets ----
const sheets = [];
live.on("CSS.styleSheetAdded", ({ header }) => sheets.push(header.styleSheetId));
await live.send("DOM.enable");
await live.send("CSS.enable");
await new Promise((r) => setTimeout(r, 150));
const propertyNames = new Set();
for (const id of sheets) {
  try {
    const { text } = await live.send("CSS.getStyleSheetText", { styleSheetId: id });
    for (const match of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) propertyNames.add(match[1]);
  } catch {}
}

const READ = String.raw`(names) => {
  // Every custom property's value as the page computes it (its var()s
  // already substituted); which of them are colours is decided in the
  // headless Chrome, where a probe element may be written to.
  const rootStyle = getComputedStyle(document.documentElement);
  const raws = [];
  for (const name of names) {
    const raw = rootStyle.getPropertyValue(name).trim();
    if (!raw || raw.length > 300) continue;
    raws.push({ name, raw });
  }

  // Visible elements: in the viewport, painted, not hidden.
  const visible = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1 || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || +s.opacity === 0) continue;
    visible.push({ el, r, s });
  }

  // The colours visible elements paint with, and how often.
  const painted = {};
  for (const { s } of visible) {
    for (const p of ['color', 'background-color', 'border-top-color', 'fill', 'stroke']) {
      const v = s.getPropertyValue(p);
      if (!v || v === 'none' || /rgba\(0, 0, 0, 0\)/.test(v)) continue;
      if (p === 'border-top-color' && s.borderTopWidth === '0px') continue;
      painted[v] = (painted[v] ?? 0) + 1;
    }
  }
  const pageBg = [getComputedStyle(document.body).backgroundColor, rootStyle.backgroundColor].find((v) => !/rgba\(0, 0, 0, 0\)/.test(v)) ?? null;
  const pageText = getComputedStyle(document.body).color;

  // Type styles on visible text.
  const typeMap = new Map();
  for (const { el, s } of visible) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim() !== '').map((n) => n.textContent.trim()).join(' ');
    if (!own) continue;
    const t = {
      family: s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''),
      size: s.fontSize, weight: +s.fontWeight, lineHeight: s.lineHeight,
      letterSpacing: s.letterSpacing === 'normal' ? undefined : s.letterSpacing,
      textTransform: s.textTransform === 'none' ? undefined : s.textTransform,
    };
    const key = JSON.stringify(t);
    const entry = typeMap.get(key) ?? { ...t, sample: own.slice(0, 60), uses: 0, tags: new Set() };
    entry.uses += 1;
    entry.tags.add(el.tagName.toLowerCase());
    typeMap.set(key, entry);
  }
  const type = [...typeMap.values()].map((t) => ({ ...t, tags: [...t.tags] })).sort((a, b) => b.uses - a.uses);

  // A selector that names one element and survives nothing but this page.
  const uniq = (el) => {
    const parts = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.id && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let i = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) i++;
      parts.unshift(e.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
      if (e === document.body) break;
    }
    return parts.join(' > ');
  };

  // Candidates: controls, and boxes that look like components.
  const kindOf = ({ el, r, s }) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (role && /^(checkbox|switch|radio|tab|tablist|combobox|menuitem|slider|progressbar|separator|tooltip|dialog|alert|status|link|button)$/.test(role)) return role;
    if (['button', 'input', 'textarea', 'select', 'a', 'label', 'img', 'table', 'nav', 'header', 'aside', 'h1', 'h2', 'h3', 'h4', 'kbd', 'code', 'hr'].includes(tag)) return tag;
    // A form field: a label and its control laid out together, the smallest box holding both.
    if (/flex|grid/.test(s.display) && r.height < 240 && el.querySelector('label') && el.querySelector('input, textarea, select, [role=combobox], [role=checkbox], [role=switch]')) {
      const inner = [...el.children].some((c) => c.querySelector && c.querySelector('label') && c.querySelector('input, textarea, select, [role=combobox], [role=checkbox], [role=switch]'));
      if (!inner) return 'field';
    }
    const radius = parseFloat(s.borderTopLeftRadius) || 0;
    const filled = !/rgba\(0, 0, 0, 0\)/.test(s.backgroundColor);
    const bordered = parseFloat(s.borderTopWidth) > 0;
    if ((filled || bordered) && radius >= r.height / 2 - 1 && r.height <= 28 && r.width <= 160 && el.innerText.trim().length > 0 && el.innerText.trim().length < 24) return 'badge';
    if ((filled || bordered) && radius > 0 && r.width >= 120 && r.height >= 48 && el.children.length >= 2) return 'card';
    if (s.display.includes('grid') && el.children.length >= 3) return 'grid';
    return null;
  };
  const groups = new Map();
  for (const v of visible) {
    const kind = kindOf(v);
    if (!kind) continue;
    // Skip controls inside a control of the same kind (a label inside a button).
    const { el, r, s } = v;
    const look = [kind, Math.round(r.height), s.backgroundColor, s.borderTopWidth, s.borderTopColor, s.borderTopLeftRadius, s.fontSize, s.fontWeight, s.color, s.paddingLeft].join('|');
    const shape = [kind, Math.round(r.height), s.borderTopLeftRadius, s.fontSize, s.paddingLeft].join('|');
    const entry = groups.get(shape) ?? { kind, instances: [], looks: new Set() };
    entry.looks.add(look);
    const cut = r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth;
    // The box you see: an element whose wrapper has exactly its box
    // (an input inside the group that draws its border) is read as the wrapper.
    let box = el;
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const u = up.getBoundingClientRect();
      if (Math.abs(u.x - r.x) > 0.01 || Math.abs(u.y - r.y) > 0.01 || Math.abs(u.width - r.width) > 0.01 || Math.abs(u.height - r.height) > 0.01) break;
      box = up;
    }
    entry.instances.push({ selector: uniq(box), rect: [r.x, r.y, r.width, r.height], text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 60), cut, area: r.width * r.height, look });
    groups.set(shape, entry);
  }
  const candidates = [...groups.values()].map((g) => {
    g.instances.sort((a, b) => Number(a.cut) - Number(b.cut) || b.area - a.area);
    return { kind: g.kind, count: g.instances.length, looks: g.looks.size, instances: g.instances.slice(0, 8).map(({ area, ...rest }) => rest) };
  });

  const icon = [...document.querySelectorAll('link[rel~="icon"]')].map((l) => ({ href: l.href, size: parseInt(l.sizes?.value) || 0, type: l.type })).sort((a, b) => b.size - a.size)[0]?.href ?? new URL('/favicon.ico', location.href).href;
  return {
    page: { title: document.title, url: location.href, favicon: icon, viewport: [innerWidth, innerHeight] },
    raws, painted, pageBg, pageText, type, candidates,
  };
}`;

const data = await evaluate(live, `(${READ})(${JSON.stringify([...propertyNames])})`);
data.page.display = await displayOf(live);

// Colours: resolved in the headless Chrome on a probe element (a
// relative colour or a bare "153deg 60% 52%" triple only a style
// resolves), each with its pixel as the display draws it.
const RESOLVE = String.raw`(raws, painted) => {
  const probe = document.body.appendChild(document.createElement('i'));
  const canvas = document.createElement('canvas').getContext('2d', { colorSpace: 'display-p3' });
  const resolve = (text) => {
    for (const attempt of [text, 'hsl(' + text + ')']) {
      probe.style.color = '';
      probe.style.color = attempt;
      if (probe.style.color === '') continue;
      const computed = getComputedStyle(probe).color;
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = computed;
      canvas.fillRect(0, 0, 1, 1);
      return { computed, px: [...canvas.getImageData(0, 0, 1, 1).data] };
    }
    return null;
  };
  const colours = [];
  for (const { name, raw } of raws) {
    if (/^-?\d*\.?\d+(px|rem|em|ms|s|%|deg)?$/.test(raw) || /^(url|var)\(/.test(raw)) continue;
    const got = resolve(raw);
    if (got) colours.push({ name, raw, ...got });
  }
  const paintedPx = Object.entries(painted).map(([value, n]) => ({ value, n, px: resolve(value)?.px })).filter((p) => p.px);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) <= 1);
  for (const c of colours) {
    c.uses = 0;
    for (const p of paintedPx) if (p.value === c.computed || near(p.px, c.px)) c.uses += p.n;
  }
  return colours;
}`;
const resolver = await headlessPage("data:text/html,<body></body>", { width: 100, height: 100, display: data.page.display });
let resolved;
let pageColours;
try {
  resolved = await evaluate(resolver.page, `(${RESOLVE})(${JSON.stringify(data.raws)}, ${JSON.stringify(data.painted)})`);
  pageColours = await evaluate(resolver.page, `(${RESOLVE})(${JSON.stringify([{ name: "bg", raw: data.pageBg ?? "transparent" }, { name: "text", raw: data.pageText }])}, {})`);
} finally {
  await resolver.close();
}
data.colours = resolved.map(({ name, raw, computed, px, uses }) => ({ name, value: computed, raw, px, uses }));
data.pageBg = pageColours.find((c) => c.name === "bg")?.px ?? null;
data.pageText = pageColours.find((c) => c.name === "text")?.px ?? null;

// Pictures: one screenshot, each candidate's first instance cut from it
// at 2x with a little of what surrounds it.
const whole = join(out, "page.png");
await stableShot(live, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, whole);
live.close();
const shot = decodePng(readFileSync(whole));
const dpr = data.page.display.dpr;
const PAD = 8;
const [vw, vh] = data.page.viewport;
const candidates = data.candidates
  .sort((a, b) => b.count - a.count)
  .map((c, k) => {
    const id = `${c.kind}-${k + 1}`;
    const [x, y, w, h] = c.instances[0].rect;
    const left = Math.max(0, x - PAD);
    const top = Math.max(0, y - PAD);
    const right = Math.min(vw, x + w + PAD);
    const bottom = Math.min(vh, y + h + PAD);
    let picture = null;
    if (right - left >= 4 && bottom - top >= 4) {
      let crop = cropPng(shot, { x: Math.round(left * dpr), y: Math.round(top * dpr), width: Math.round((right - left) * dpr), height: Math.round((bottom - top) * dpr) });
      if (dpr !== 2) crop = scalePng(crop, 2 / dpr);
      picture = join(out, `${id}.png`);
      writeFileSync(picture, encodePng(crop));
    }
    return { id, ...c, picture };
  });

// Colours: the ones the page paints with and their families, one name per colour.
const near = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= 1);
const SEMANTIC = /^(background|foreground|border|brand|primary|secondary|accent|muted|destructive|danger|warning|success|info|error|surface|text|ring|input|card|popover)/;
const groupOf = (name) => name.replace(/^--(color-)?/, "").split("-")[0] || "colour";
// A value a reader can take in: the page's own when it is a plain colour,
// else the colour the display draws for it.
const readable = (value, px) => {
  if (/^(#|rgb|hsl|oklch|oklab|lab|lch)\(?/.test(value) && !/\b(from|calc|var)\b/.test(value) && !/^\d/.test(value)) return value;
  const [r, g, b, a] = px.map((v) => +(v / 255).toFixed(4));
  return a === 1 ? `color(display-p3 ${r} ${g} ${b})` : `color(display-p3 ${r} ${g} ${b} / ${a})`;
};
// A product's own system is its large semantic families (background-*,
// foreground-*, border-*, …): kept whole, every member. Loose aliases of
// the same colours (card, popover, color-white) and the colours the
// page paints outside any family are added only where no family member
// already holds that colour.
const colours = data.colours.map(({ name, value, px, uses }) => ({ name: name.replace(/^--/, ""), value, px, uses }));
const families = new Map();
for (const c of colours) {
  if (!SEMANTIC.test(c.name) || c.px[3] === 0) continue;
  const group = groupOf(c.name);
  families.set(group, [...(families.get(group) ?? []), c]);
}
const system = [...families.values()].filter((members) => members.length >= 3).flat();
const held = new Set(system.map((c) => c.px.join(",")));
const extras = [];
for (const c of colours.filter((x) => x.uses > 0 && x.px[3] > 0).sort((a, b) => b.uses - a.uses)) {
  const key = c.px.join(",");
  if (held.has(key) || /^(tw-|chart|sidebar)/.test(c.name)) continue;
  held.add(key);
  extras.push(c);
}
const palette = [...system, ...extras]
  .map((c) => ({ name: c.name, value: readable(c.value, c.px), group: groupOf(c.name), px: c.px }))
  .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
const pick = (px) => palette.find((c) => near(c.px, px));
const surface = pick(data.pageBg);
const text = pick(data.pageText);
if (surface) surface.role = "surface";
if (text && text !== surface) text.role = "text";

// ---- a draft plan: every candidate a component, every look a state ----
// The orchestrator's edit, not its starting point from scratch: names
// come from the kind and the text, so they are placeholders to rename
// to the product's own; decoration and hidden elements are left out.
const NAMES = {
  button: "Button", a: "Link", link: "Link", input: "Input", textarea: "Text area", select: "Select", combobox: "Select",
  checkbox: "Checkbox", switch: "Switch", radio: "Radio", tab: "Tab", tablist: "Tabs", menuitem: "Menu item", slider: "Slider",
  progressbar: "Progress", badge: "Badge", label: "Label", field: "Form field", card: "Card", header: "Header", nav: "Navigation",
  aside: "Sidebar", table: "Table", img: "Image", h1: "Heading", h2: "Heading", h3: "Heading", h4: "Heading", kbd: "Keyboard key",
  code: "Code", hr: "Divider", separator: "Divider", tooltip: "Tooltip", dialog: "Dialog", alert: "Alert", status: "Status",
};
const INTERACTIVE = new Set(["button", "a", "link", "input", "textarea", "combobox", "checkbox", "switch", "radio", "tab", "menuitem", "slider"]);
const slugOf = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "component";
const draft = { palette: palette.map(({ px, ...rest }) => rest), type: data.type.map(({ tags, uses, ...rest }) => ({ ...rest, tags })), components: [] };
const usedSlugs = new Set();
const sameKind = new Map();
for (const c of candidates) sameKind.set(c.kind, (sameKind.get(c.kind) ?? 0) + 1);
for (const c of candidates) {
  if (c.kind === "grid" || c.kind === "select") continue;
  const first = c.instances[0];
  if (first.rect[2] < 4 || first.rect[3] < 4) continue;
  const base = NAMES[c.kind] ?? c.kind;
  const label = first.text.split(" ").slice(0, 3).join(" ");
  const name = sameKind.get(c.kind) > 1 && label ? `${base}: ${label}` : base;
  let slug = slugOf(name);
  for (let n = 2; usedSlugs.has(slug); n++) slug = `${slugOf(name)}-${n}`;
  usedSlugs.add(slug);
  const looks = [];
  for (const instance of c.instances) {
    if (looks.some((l) => l.look === instance.look)) continue;
    looks.push(instance);
  }
  const states = looks.map((instance, k) => ({
    name: k === 0 ? "Default" : instance.text.slice(0, 24) || `Look ${k + 1}`,
    selector: instance.selector,
  }));
  const names = new Set();
  for (const state of states) {
    let name = state.name;
    for (let n = 2; names.has(name); n++) name = `${state.name} ${n}`;
    names.add(name);
    state.name = name;
  }
  if (INTERACTIVE.has(c.kind)) {
    states.push({ name: "Hover", selector: first.selector, force: "hover" });
    states.push({ name: "Focus", selector: first.selector, force: "focus-visible" });
  }
  draft.components.push({ slug, name, picture: c.picture, states });
}
const draftPath = join(out, "plan.draft.json");
writeFileSync(draftPath, JSON.stringify(draft, null, 2) + "\n");

// Everything, for whoever needs more than the summary.
writeFileSync(
  join(out, "survey.json"),
  JSON.stringify({ draft: draftPath, page: data.page, palette: palette.map(({ px, ...rest }) => rest), colours: colours.length, type: data.type, candidates }, null, 1) + "\n",
);

// The summary the orchestrator plans from: the page, and the draft one
// component a line with its looks, their texts and its picture.
const lines = [
  `page: ${data.page.title} | ${data.page.url.split("?")[0]} | favicon ${data.page.favicon}`,
  `colours: ${palette.length} (of ${colours.length} colour properties) | type styles: ${data.type.length} | display ${data.page.display.dpr}x ${data.page.display.colorProfile}`,
  `draft: ${draftPath} (full survey: ${join(out, "survey.json")})`,
  "components (slug | looks | picture):",
  ...draft.components.map((c) => {
    const group = candidates.find((k) => k.picture === c.picture);
    const looks = c.states.filter((st) => !st.force).map((st) => {
      const text = group?.instances.find((i) => i.selector === st.selector)?.text ?? "";
      return `${st.name}${text ? ` "${text.slice(0, 30)}"` : ""}${group?.instances.find((i) => i.selector === st.selector)?.cut ? " (cut)" : ""}`;
    });
    const held = c.states.some((st) => st.force) ? " +hover/focus" : "";
    return `  ${c.slug} | ${looks.join(", ")}${held} | ${c.picture ?? "no picture"}`;
  }),
];
console.log(lines.join("\n"));
process.exit(0);
