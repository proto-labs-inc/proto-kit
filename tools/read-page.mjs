/**
 * One read of the reference page for a prototype build: everything a
 * later step needs, captured at once under the Proto window's lock, so
 * nothing reads the live page again until the checks.
 *
 * What the read holds (docs/build-read.md):
 *   - every element under <body>: tag, attributes, children (elements
 *     and text), the whole computed style, its ::before/::after and
 *     ::placeholder where they paint, its box; styles are interned (a
 *     shared property list, a shared pool of values) so a page of a few
 *     thousand elements is a few megabytes;
 *   - the tree the site shows: boxes chosen by size, largest first,
 *     within a budget, with repeated siblings folded into their parent
 *     (a list of eight icon buttons is one box, not nine), each box
 *     naming its element, its own text, aria label, heading, role and
 *     the classes that look like names;
 *   - the page's custom properties on :root and body (its tokens), the
 *     body's own face and colours, the title and icon;
 *   - the page's @font-face rules with the font files, and every image
 *     the page shows, saved beside the read.
 *
 * `readPage(live, { maxNodes })` runs the page-side read and returns
 * { tree, read }; `captureAssets(live, read, dir)` saves fonts and
 * images into `dir` and records where. Both are called by
 * tools/build-stream.mjs read, inside the frame's lock.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { evaluate } from "./cdp/cdp.mjs";
import { fontFaces } from "./snapshot.mjs";

/** How many boxes the tree shows at most, and how deep it goes. */
export const MAX_NODES = 160;
export const MAX_DEPTH = 12;
// Siblings this many of a kind, alike in size, are one repeating part.
const REPEAT_FROM = 4;

// The page-side read. Written as one function so a single evaluate
// gathers every element and the tree over the same element indices.
const PAGE_READ = String.raw`(maxNodes, maxDepth, repeatFrom) => {
  const vw = innerWidth, vh = innerHeight;
  const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE", "HEAD", "TITLE"]);
  const skip = (el) => SKIP.has(el.tagName);

  // ---- every element, in document order, with interned styles ----
  const elements = [];
  (function collect(el) {
    if (skip(el)) return;
    elements.push(el);
    for (const child of el.children) collect(child);
  })(document.body);
  const index = new Map(elements.map((el, i) => [el, i]));
  const probe = getComputedStyle(document.body);
  const props = [];
  for (let i = 0; i < probe.length; i++) if (!probe[i].startsWith("--")) props.push(probe[i]);
  const pool = [];
  const poolIndex = new Map();
  const intern = (value) => {
    let at = poolIndex.get(value);
    if (at === undefined) { at = pool.length; pool.push(value); poolIndex.set(value, at); }
    return at;
  };
  const styleOf = (el, pseudo) => {
    const s = getComputedStyle(el, pseudo);
    const out = new Array(props.length);
    for (let i = 0; i < props.length; i++) out[i] = intern(s.getPropertyValue(props[i]));
    return out;
  };
  const records = elements.map((el, i) => {
    const children = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1 && index.has(child)) children.push({ node: index.get(child) });
      else if (child.nodeType === 3) children.push({ text: child.textContent });
    }
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    if (el.tagName === "IMG" && el.currentSrc) { attrs.src = el.currentSrc; delete attrs.srcset; delete attrs.sizes; }
    const pseudo = {};
    for (const which of ["::before", "::after"]) {
      const s = getComputedStyle(el, which);
      if (s.content && s.content !== "none" && s.content !== "normal") pseudo[which] = styleOf(el, which);
    }
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") pseudo["::placeholder"] = styleOf(el, "::placeholder");
    const r = el.getBoundingClientRect();
    const tag = el.localName;
    return {
      i, tag, svg: el.namespaceURI === "http://www.w3.org/2000/svg",
      parent: i === 0 ? -1 : index.get(el.parentElement) ?? -1,
      attrs, children, style: styleOf(el), pseudo,
      value: tag === "input" || tag === "textarea" ? el.value : null,
      rect: [r.x, r.y, r.width, r.height],
    };
  });

  // ---- the tree: boxes by size, largest first, within the budget ----
  const label = (el) => {
    const cls = (typeof el.className === "string" ? el.className : "")
      .split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")).slice(0, 2).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const selector = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const parent = e.parentElement;
      const at = parent ? [...parent.children].indexOf(e) + 1 : 1;
      parts.unshift(e.tagName.toLowerCase() + ":nth-child(" + at + ")");
    }
    return "body > " + parts.join(" > ");
  };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const shows = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
  };
  // A zero-size wrapper (display: contents, an empty-box layout shell) is
  // not a box, but its children lay out normally: look through it.
  const kids = (el) => [...el.children].filter((c) => !skip(c)).flatMap((c) => {
    const r = c.getBoundingClientRect();
    const s = getComputedStyle(c);
    if ((r.width < 1 || r.height < 1) && s.display !== "none") return kids(c);
    return [c];
  });
  const same = (a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1 && Math.abs(p.width - q.width) < 1 && Math.abs(p.height - q.height) < 1; };
  const area = (el) => { const r = el.getBoundingClientRect(); const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(vw, r.right), y1 = Math.min(vh, r.bottom); return Math.max(0, x1 - x0) * Math.max(0, y1 - y0); };
  // Siblings of one kind and one size, from repeatFrom up, making most
  // of the row: a list, a grid of cards, a strip of glyphs. The parent
  // is then one part, read whole; the tree does not spend boxes on
  // each copy.
  const repeats = (shown) => {
    if (shown.length < repeatFrom) return false;
    const groups = new Map();
    for (const c of shown) { const k = label(c); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
    for (const group of groups.values()) {
      if (group.length < repeatFrom || group.length < shown.length * 0.6) continue;
      const sizes = group.map((c) => c.getBoundingClientRect());
      const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const mw = median(sizes.map((r) => r.width)), mh = median(sizes.map((r) => r.height));
      const alike = sizes.filter((r) => Math.abs(r.width - mw) <= Math.max(4, mw * 0.25) && Math.abs(r.height - mh) <= Math.max(4, mh * 0.25));
      if (alike.length >= group.length * 0.8) return true;
    }
    return false;
  };
  // Names the page gives a box: its aria label, a heading inside it, a
  // role, and classes that read as names rather than utilities.
  const UTILITY = /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|static|items-|justify-|content-|self-|place-|gap-|space-|p[xytrbl]?-|m[xytrbl]?-|w-|h-|min-|max-|text-|font-|leading-|tracking-|bg-|border|rounded|shadow|opacity|z-|overflow|truncate|whitespace|break-|cursor|select-|pointer-|transition|duration|ease|animate|transform|scale|rotate|translate|order-|col-|row-|shrink|grow|basis|aspect|object-|top-|left-|right-|bottom-|inset|size-|divide|ring|outline|fill-|stroke-|from-|via-|to-|sr-only|group|peer|container|antialiased|uppercase|lowercase|capitalize|underline|no-underline|list-|table|visible|invisible|isolate|will-change|touch|resize|appearance|decoration|line-clamp|not-|first|last|odd|even|dark|light|md|lg|xl|sm|xs|hover|focus|active|disabled|data-|aria-)/;
  const semanticClasses = (el) => (typeof el.className === "string" ? el.className : "")
    .split(/\s+/)
    .filter((c) => c && !/[:[\](@/!]/.test(c) && !/^-|\d{2,}|__|--|^[A-Za-z0-9]{1,2}$/.test(c) && !UTILITY.test(c))
    .map((c) => c.replace(/_[A-Za-z0-9]{5,}$/, ""))
    .slice(0, 3);
  const ownText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).filter(Boolean).join(" ").slice(0, 40) || null;
  const headingOf = (el) => { const h = el.matches("h1,h2,h3,h4,h5,h6") ? el : el.querySelector("h1,h2,h3,h4,h5,h6"); return h ? (h.innerText || "").trim().slice(0, 40) || null : null; };
  // The colour a box sits on: its painted ancestors, composited.
  const backdropOf = (root) => {
    const layers = [];
    for (let el = root.parentElement; el; el = el.parentElement) {
      const bg = getComputedStyle(el).backgroundColor;
      layers.push(bg);
      const p = document.createElement("canvas").getContext("2d", { colorSpace: "display-p3" });
      p.fillStyle = bg; p.fillRect(0, 0, 1, 1);
      if (p.getImageData(0, 0, 1, 1).data[3] === 255) break;
    }
    if (layers.length === 0) layers.push(getComputedStyle(document.documentElement).backgroundColor);
    layers.reverse();
    const visible = layers.filter((c) => { const p = document.createElement("canvas").getContext("2d"); p.fillStyle = c; p.fillRect(0, 0, 1, 1); return p.getImageData(0, 0, 1, 1).data[3] > 0; });
    if (visible.length === 0) return null;
    if (visible.length === 1) return visible[0];
    const c = document.createElement("canvas").getContext("2d", { colorSpace: "display-p3" });
    for (const layer of visible) { c.fillStyle = layer; c.fillRect(0, 0, 1, 1); }
    const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
    return "color(display-p3 " + [r, g, b].map((v) => +(v / 255).toFixed(4)).join(" ") + ")";
  };
  const roomOf = (root) => {
    if (!root.parentElement) return null;
    const ps = getComputedStyle(root.parentElement);
    return root.parentElement.getBoundingClientRect().width - parseFloat(ps.paddingLeft) - parseFloat(ps.paddingRight) - parseFloat(ps.borderLeftWidth) - parseFloat(ps.borderRightWidth);
  };

  const nodes = [];
  const candidates = [{ el: document.body, parent: null, depth: 0 }];
  while (candidates.length && nodes.length < maxNodes) {
    // The largest box waiting is read next, so the budget goes to what
    // the page is made of, not to whichever corner the walk reached first.
    let best = 0;
    for (let i = 1; i < candidates.length; i++) if (area(candidates[i].el) > area(candidates[best].el)) best = i;
    let { el, parent, depth } = candidates.splice(best, 1)[0];
    let raw = label(el);
    for (;;) {
      const only = kids(el).filter(shows);
      if (only.length === 1 && same(el, only[0])) { el = only[0]; raw += " > " + label(el); } else break;
    }
    const r = box(el);
    const id = "n" + (nodes.length + 1);
    const shown = kids(el).filter(shows);
    const folded = repeats(shown);
    const node = {
      id, parent, depth, raw: raw.length > 110 ? raw.slice(0, 107) + "…" : raw,
      rect: { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.w, vw - Math.max(0, r.x)), h: Math.min(r.h, vh - Math.max(0, r.y)) },
      selector: selector(el),
      protoId: el.getAttribute("data-proto-id"),
      text: (el.innerText || "").trim().split("\n")[0].trim().slice(0, 40) || null,
      element: index.get(el) ?? null,
      tag: el.localName,
      aria: el.getAttribute("aria-label"),
      role: el.getAttribute("role"),
      heading: headingOf(el),
      classes: semanticClasses(el),
      ownText: ownText(el),
      interactive: el.matches("a, button, input, select, textarea, label, summary, [role=button], [role=link], [role=tab], [role=menuitem]"),
      backdrop: backdropOf(el),
      room: roomOf(el),
    };
    if (folded) { node.collapsed = "repeats"; node.count = shown.length; }
    nodes.push(node);
    if (!folded && depth + 1 < maxDepth) for (const child of shown) candidates.push({ el: child, parent: id, depth: depth + 1 });
  }
  // Boxes are listed parent before child, root first, so the site draws
  // them root down; the order within a level is the order they were read.
  const depthFirst = [];
  const byParent = new Map();
  for (const n of nodes) { if (!byParent.has(n.parent)) byParent.set(n.parent, []); byParent.get(n.parent).push(n); }
  (function visit(parent) { for (const n of byParent.get(parent) ?? []) { depthFirst.push(n); visit(n.id); } })(null);
  const renamed = new Map(depthFirst.map((n, i) => [n.id, "n" + (i + 1)]));
  for (const n of depthFirst) { n.id = renamed.get(n.id); n.parent = n.parent === null ? null : renamed.get(n.parent); }

  // ---- the page itself: tokens, face, colours, title, icon ----
  const customProps = (el) => {
    const s = getComputedStyle(el);
    const out = {};
    for (let i = 0; i < s.length; i++) if (s[i].startsWith("--")) out[s[i]] = s.getPropertyValue(s[i]).trim();
    return out;
  };
  const bodyStyle = getComputedStyle(document.body);
  const htmlStyle = getComputedStyle(document.documentElement);
  const icon = document.querySelector('link[rel~="icon"]');
  const page = {
    url: location.href,
    title: document.title,
    lang: document.documentElement.lang || null,
    icon: icon ? new URL(icon.getAttribute("href"), location.href).toString() : null,
    htmlAttrs: Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])),
    tokens: { root: customProps(document.documentElement), body: customProps(document.body) },
    html: { fontSize: htmlStyle.fontSize, backgroundColor: htmlStyle.backgroundColor, color: htmlStyle.color, colorScheme: htmlStyle.colorScheme },
    body: Object.fromEntries(["background-color", "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "-webkit-font-smoothing", "text-rendering", "margin-top", "margin-right", "margin-bottom", "margin-left", "min-height", "overflow-x", "overflow-y"].map((k) => [k, bodyStyle.getPropertyValue(k)])),
    rootFontSize: parseFloat(htmlStyle.fontSize),
  };
  const images = [...new Set(elements.filter((el) => el.tagName === "IMG" && el.currentSrc && !el.currentSrc.startsWith("data:")).map((el) => el.currentSrc))];

  window.__protoRead = JSON.stringify({
    viewport: { width: vw, height: vh, dpr: devicePixelRatio },
    url: location.href,
    nodes: depthFirst,
    read: { props, pool, elements: records, page, images },
  });
  return window.__protoRead.length;
}`;

// Pulled in slices: one evaluate carrying a whole page's styles is too
// large a frame for the socket to be trusted with.
const SLICE = 4_000_000;

/**
 * Read the page: -> { tree, read }. `tree` is what tree.json holds
 * (viewport, url, nodes); `read` is the element records, the page's
 * tokens and the image urls. Call under the window's lock.
 */
export async function readPage(live, { maxNodes = MAX_NODES, maxDepth = MAX_DEPTH } = {}) {
  const length = await evaluate(live, `(${PAGE_READ})(${maxNodes}, ${maxDepth}, ${REPEAT_FROM})`);
  let text = "";
  for (let at = 0; at < length; at += SLICE) text += await evaluate(live, `window.__protoRead.slice(${at}, ${at + SLICE})`);
  await evaluate(live, "delete window.__protoRead; true");
  const { viewport, url, nodes, read } = JSON.parse(text);
  return { tree: { viewport, url, nodes }, read };
}

/**
 * The page's fonts and images, saved into `dir`: each @font-face rule
 * with its files (url → path) and each image (url → path). Files come
 * from the page's own cache first (Page.getResourceContent, so an image
 * behind the user's sign-in is theirs), then over the network.
 */
export async function captureAssets(live, read, dir) {
  mkdirSync(dir, { recursive: true });
  const { frameTree } = await live.send("Page.getResourceTree");
  const frameId = frameTree.frame.id;
  const fromCache = async (url) => {
    try {
      const { content, base64Encoded } = await live.send("Page.getResourceContent", { frameId, url });
      return Buffer.from(content, base64Encoded ? "base64" : "utf8");
    } catch {
      return null;
    }
  };
  const fetched = async (url) => {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" } });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };
  const taken = new Set();
  const nameFor = (url, fallback) => {
    let name = fallback;
    try {
      name = basename(new URL(url).pathname).replace(/[^A-Za-z0-9._-]/g, "") || fallback;
    } catch {}
    for (let n = 2; taken.has(name); n++) name = `${n}-${name}`;
    taken.add(name);
    return name;
  };
  const save = async (url, fallback) => {
    const bytes = (await fromCache(url)) ?? (await fetched(url).catch(() => null));
    if (!bytes || bytes.length === 0) return null;
    const path = join(dir, nameFor(url, fallback));
    writeFileSync(path, bytes);
    return path;
  };

  const faces = [];
  for (const face of await fontFaces(live)) {
    const files = {};
    for (const match of face.body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      if (match[1].startsWith("data:")) continue;
      const absolute = new URL(match[1], face.base ?? read.page.url).toString();
      if (files[absolute] !== undefined) continue;
      const path = await save(absolute, `font-${faces.length + 1}.woff2`);
      if (path) files[absolute] = path;
    }
    faces.push({ family: face.family, body: face.body, base: face.base, files });
  }
  const assets = {};
  for (const url of read.images) {
    const path = await save(url, `image-${Object.keys(assets).length + 1}`);
    if (path) assets[url] = path;
  }
  return { faces, assets };
}

/** The interned style of one element record as a { property: value } object. */
export function styleOf(read, values) {
  const out = {};
  for (let i = 0; i < read.props.length; i++) out[read.props[i]] = read.pool[values[i]];
  return out;
}

/**
 * The instance tools/snapshot.mjs writes a component from, cut from a
 * captured read at element `at`: the element and its descendants,
 * re-indexed from 0, with styles expanded. `backdrop` and `room` are
 * the tree node's (the read computed them on the page).
 */
export function instanceFromRead(read, at, { backdrop = null, room = null } = {}) {
  const picked = [];
  (function collect(i) {
    picked.push(i);
    for (const child of read.elements[i].children) if (child.node !== undefined) collect(child.node);
  })(at);
  const local = new Map(picked.map((i, k) => [i, k]));
  const nodes = picked.map((i, k) => {
    const el = read.elements[i];
    return {
      i: k,
      tag: el.tag,
      svg: el.svg,
      parent: k === 0 ? -1 : local.get(el.parent) ?? -1,
      attrs: { ...el.attrs },
      children: el.children.map((child) => (child.node !== undefined ? { node: local.get(child.node) } : { text: child.text })),
      style: styleOf(read, el.style),
      pseudo: Object.fromEntries(Object.entries(el.pseudo).map(([which, values]) => [which, styleOf(read, values)])),
      value: el.value,
      rect: [...el.rect],
    };
  });
  return { nodes, backdrop, room, rootFontSize: read.page.rootFontSize, base: read.page.url };
}

/** Whether a build folder holds a read (tree.json and read.json). */
export const hasRead = (dir) => existsSync(join(dir, "tree.json")) && existsSync(join(dir, "read.json"));
