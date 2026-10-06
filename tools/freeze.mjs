#!/usr/bin/env node
/**
 * The copy of the reference page, frozen as it renders: the live tab's
 * DOM after its scripts ran, the page's own stylesheets as written, and
 * every asset it loaded, saved into the workspace. Nothing is rebuilt:
 * the copy draws exactly what the page drew, so there is no part to fix.
 *
 * Usage: node tools/freeze.mjs <briefId> --codebase <id> [--port 9333] [--keep-dev] [--no-send]
 *
 * Needs the build folder's read (tree.json, with the curation's names)
 * and a scaffolded workspace (workspace.json). Writes into the workspace:
 *   src/frozen/page.html      the body's markup, scripts removed, with
 *                             every curated part and section marked
 *                             (data-proto-id) and every element numbered
 *                             (data-pf, the read's order)
 *   src/frozen/frozen.json    <html> and <body> attributes, the
 *                             stylesheets in order, the viewport, the url
 *   src/frozen/Frozen.tsx     mounts the page into <body> and puts React
 *                             components in place of marked elements
 *   public/frozen/styles/     the page's stylesheets, urls made local
 *   public/frozen/assets/     fonts, images and icons it loaded
 *   src/App.tsx               <Frozen /> (the agent's change goes here)
 * Then renders the workspace in the headless Chrome and checks every
 * marked box's position and size against the read (renderer-independent),
 * and saves checks/frozen.png. Prints one JSON line with the parts list.
 *
 * The page's scripts are not kept: a single-page app's bundle would run
 * again against a copy without its server and replace the frozen markup.
 * CSS behaviour (hover, focus, transitions, media queries) keeps working;
 * what scripts did on click is rebuilt in React where the change needs it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFolder } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { workflowEvent } from "./workflow-report.mjs";
import { findPage } from "./cdp/attach.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { headlessPage, displayOf } from "./cdp/headless.mjs";
import { stableShot } from "./cdp/capture.mjs";
import { cropPng, decodePng, encodePng } from "./cdp/png.mjs";
import { withLive } from "./cdp/live.mjs";
import { liveMatchOf } from "./check.mjs";
import { ensureDevServer } from "./dev-server.mjs";

const args = process.argv.slice(2);
const options = { port: "9333" };
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (["--keep-dev", "--no-send"].includes(args[i])) options[args[i].slice(2)] = true;
  else if (args[i].startsWith("--")) options[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [briefId] = positional;
const fail = (message) => {
  console.error(`freeze: ${message}`);
  process.exit(1);
};
if (!briefId || !options.codebase) fail("usage: node tools/freeze.mjs <briefId> --codebase <id> [--port 9333] [--keep-dev] [--no-send]");
const codebase = options.codebase;
const buildDir = buildFolder(codebase, briefId);
const say = (line) => console.error(`freeze: ${line}`);
const began = Date.now();
const timings = {};
const stage = (name, from) => (timings[name] = Math.round((Date.now() - from) / 100) / 10);

// ---- the files the freeze writes into the workspace ----
const FROZEN_TSX = `import { useLayoutEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import html from "./page.html?raw";
import meta from "./frozen.json";

type Attrs = Record<string, string>;
const attrsOf = (el: Element): Attrs => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));
const setAttrs = (el: Element, attrs: Attrs) => {
  for (const a of [...el.attributes]) if (!(a.name in attrs) && !a.name.startsWith("data-proto")) el.removeAttribute(a.name);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
};
// Built, not written out: verify-markers reads a literal attribute here as a marker.
const MARKER = ["data", "proto", "id"].join("-");
const markerSelector = (marker: string) => \`[\${MARKER}="\${CSS.escape(marker)}"]\`;

/**
 * The reference page as it rendered, frozen (tools/freeze.mjs). Its
 * markup goes straight into <body>, before #root, because the page's own
 * CSS targets body's children; its stylesheets go into <head> in order.
 *
 * \`replace\` puts a React node in place of each marked element, keyed by
 * its marker (data-proto-id): the element is swapped for a slot with
 * \`display: contents\`, so the node lays out exactly where the element did.
 * Everything not replaced stays the page's own markup.
 */
export function Frozen({ replace = {} }: { replace?: Record<string, ReactNode> }) {
  const [slots, setSlots] = useState<Record<string, HTMLElement>>({});
  const keys = Object.keys(replace).join("|");
  useLayoutEffect(() => {
    const links = meta.styles.map((sheet) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      if (sheet.media) link.media = sheet.media;
      link.dataset.frozen = "";
      document.head.appendChild(link);
      return link;
    });
    const savedHtml = attrsOf(document.documentElement);
    const savedBody = attrsOf(document.body);
    setAttrs(document.documentElement, meta.htmlAttrs as Attrs);
    setAttrs(document.body, meta.bodyAttrs as Attrs);
    const root = document.getElementById("root");
    const template = document.createElement("template");
    template.innerHTML = html;
    const inserted = [...template.content.childNodes];
    for (const node of inserted) document.body.insertBefore(node, root);
    const found: Record<string, HTMLElement> = {};
    for (const marker of Object.keys(replace)) {
      const element = document.body.querySelector(markerSelector(marker));
      if (!element) {
        console.warn(\`Frozen: no element marked "\${marker}" in page.html\`);
        continue;
      }
      const slot = document.createElement("div");
      slot.style.display = "contents";
      slot.dataset.protoSlot = marker;
      element.replaceWith(slot);
      found[marker] = slot;
    }
    setSlots(found);
    // The frozen page's links and forms point at the live product: a click
    // there would leave the prototype. Inside a replacement, the change's
    // own components decide.
    const isFrozen = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null;
      return Boolean(element && !element.closest("[data-proto-slot]") && inserted.some((node) => node.contains(element)));
    };
    const stayOnPage = (event: Event) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (link && isFrozen(link)) event.preventDefault();
    };
    const keepForms = (event: Event) => {
      if (isFrozen(event.target)) event.preventDefault();
    };
    document.addEventListener("click", stayOnPage, true);
    document.addEventListener("submit", keepForms, true);
    return () => {
      document.removeEventListener("click", stayOnPage, true);
      document.removeEventListener("submit", keepForms, true);
      for (const node of inserted) node.parentNode?.removeChild(node);
      for (const slot of Object.values(found)) slot.remove();
      for (const link of links) link.remove();
      setAttrs(document.documentElement, savedHtml);
      setAttrs(document.body, savedBody);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  return <>{Object.entries(slots).map(([marker, slot]) => (replace[marker] ? createPortal(replace[marker], slot, marker) : null))}</>;
}

/** A marked element's frozen markup, as a string: a variant set's "current" option. */
export function original(marker: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.querySelector(markerSelector(marker))?.outerHTML ?? "";
}

/** Frozen markup rendered as it was (for the "current" option of a variant set). */
export function FrozenHtml({ marker }: { marker: string }) {
  return <div style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: original(marker) }} />;
}
`;

const APP_TSX = `import { Frozen } from "./frozen/Frozen";

/**
 * The reference page, frozen exactly as it rendered (src/frozen/page.html,
 * its own stylesheets in public/frozen/styles). Make the change by putting
 * components in place of marked elements:
 *
 *   <Frozen replace={{ "paused-notice": <PausedNoticeVariants /> }} />
 *
 * The key is the element's data-proto-id in page.html. A replacement's root
 * keeps that marker so comments stay anchored. Small edits to text or
 * attributes can be made in page.html directly.
 */
export function App() {
  return <Frozen />;
}
`;

const tree = JSON.parse(readFileSync(join(buildDir, "tree.json"), "utf8"));
const workspaceRecord = JSON.parse(readFileSync(join(buildDir, "workspace.json"), "utf8"));
const workspace = workspaceRecord.path;
const reporter = createReporter({ codebase, briefId, runDir: buildDir, sink: options["no-send"] ? "file" : "site" });
reporter.send([workflowEvent(buildDir, "copy", "Freezing your page exactly as it renders")]);

// The curated boxes to mark: every part and section, by the read's selector.
const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
const marks = (tree.curation ?? [])
  .map((entry) => ({ id: entry.id, marker: entry.marker, role: entry.role, name: entry.name, selector: nodes.get(entry.id)?.selector }))
  .filter((entry) => entry.selector && entry.marker);

// ---- the page, serialized in the tab it renders in ----
const SERIALIZE = (markList) => `(async () => {
  const abs = (u, base) => { try { return new URL(u, base).href } catch { return u } };
  const urlsIn = (css, base) => css.replace(/url\\(\\s*(['"]?)([^'")]+)\\1\\s*\\)/g, (m, q, u) => u.startsWith('data:') || u.startsWith('#') ? m : 'url("' + abs(u, base) + '")');
  // Each sheet as written: the CSSOM rounds numbers to six digits and
  // shifts text a pixel; it is used only for rules a script added.
  const sheets = [];
  const all = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
  for (const s of all) {
    let cssom = null;
    try { cssom = [...s.cssRules].map(r => r.cssText).join('\\n') } catch {}
    let raw = null;
    if (s.href) { try { raw = await (await fetch(s.href, { credentials: 'include' })).text() } catch {} }
    else if (s.ownerNode && s.ownerNode.textContent) raw = s.ownerNode.textContent;
    let text = cssom;
    if (raw !== null) { try { const t = new CSSStyleSheet(); t.replaceSync(raw.replace(/@import[^;]+;/g, '')); if (cssom === null || t.cssRules.length >= s.cssRules.length - (raw.match(/@import/g) || []).length) text = raw } catch {} }
    // A cross-origin sheet without CORS: neither its rules nor a fetch
    // reach it from here; the tool reads it from the tab's cache instead.
    const base = s.href || location.href;
    sheets.push({ text: text === null ? null : urlsIn(text, base), href: s.href || null, media: s.media ? s.media.mediaText : '' });
  }
  // Form state and canvases live on the node, not in the markup.
  for (const el of document.querySelectorAll('input, textarea, select')) {
    if (el.type === 'checkbox' || el.type === 'radio') el.toggleAttribute('checked', el.checked);
    else if (el.tagName === 'TEXTAREA') el.textContent = el.value;
    else if (el.tagName === 'SELECT') for (const o of el.options) o.toggleAttribute('selected', o.selected);
    else if (el.type !== 'password' && el.type !== 'file') el.setAttribute('value', el.value);
  }
  const live = [...document.body.querySelectorAll('*')];
  const marked = new Map();
  for (const m of ${JSON.stringify(markList)}) {
    let el = null; try { el = document.querySelector(m.selector) } catch {}
    if (el && el !== document.body) { const i = live.indexOf(el); if (i >= 0 && !marked.has(i)) marked.set(i, m.marker) }
  }
  const canvases = live.map(el => { if (el.tagName !== 'CANVAS') return null; try { return el.toDataURL() } catch { return null } });
  const body = document.body.cloneNode(true);
  const copy = [...body.querySelectorAll('*')];
  copy.forEach((el, i) => {
    el.setAttribute('data-pf', String(i));
    if (marked.has(i) && !el.hasAttribute('data-proto-id')) el.setAttribute('data-proto-id', marked.get(i));
  });
  copy.forEach((el, i) => {
    if (el.tagName === 'CANVAS' && canvases[i]) { const img = document.createElement('img'); for (const a of el.attributes) img.setAttribute(a.name, a.value); img.src = canvases[i]; el.replaceWith(img) }
    if (el.tagName === 'IMG') { const src = live[i] && live[i].currentSrc; if (src) el.setAttribute('src', src); el.removeAttribute('srcset'); el.removeAttribute('loading'); el.removeAttribute('sizes') }
    if (el.tagName === 'SOURCE' && el.parentElement && el.parentElement.tagName === 'PICTURE') el.remove();
    if (el.hasAttribute && el.hasAttribute('style')) el.setAttribute('style', urlsIn(el.getAttribute('style'), location.href));
    for (const a of ['href', 'src', 'xlink:href', 'poster']) { const v = el.getAttribute && el.getAttribute(a); if (v && !v.startsWith('#') && !v.startsWith('data:') && !v.startsWith('javascript:')) el.setAttribute(a, abs(v, location.href)) }
    for (const a of [...(el.attributes || [])]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  for (const el of body.querySelectorAll('script, noscript, link[rel=preload], link[rel=modulepreload], link[rel=prefetch], style, link[rel~=stylesheet]')) el.remove();
  // Assets: every url the markup and the sheets point at.
  const assets = new Set();
  const collect = (s) => { for (const m of s.matchAll(/url\\("([^"]+)"\\)/g)) if (/^https?:/.test(m[1])) assets.add(m[1]) };
  sheets.forEach(s => s.text && collect(s.text));
  for (const el of body.querySelectorAll('img[src], image, use, video[poster]')) { const v = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href') || el.getAttribute('poster'); if (v && /^https?:/.test(v)) assets.add(v.split('#')[0]) }
  for (const el of body.querySelectorAll('[style]')) collect(el.getAttribute('style'));
  const attrs = (el) => Object.fromEntries([...el.attributes].map(a => [a.name, a.value]));
  return JSON.stringify({
    html: body.innerHTML,
    htmlAttrs: attrs(document.documentElement),
    bodyAttrs: attrs(document.body),
    sheets,
    assets: [...assets],
    title: document.title,
    url: location.href,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollHeight: document.documentElement.scrollHeight },
    elements: live.length,
    marked: marked.size,
  });
})()`;

const tab = await findPage(liveMatchOf(tree.url), Number(options.port)).catch(() => null);
if (!tab) fail(`the reference page (${liveMatchOf(tree.url)}) is not open in the Proto window`);
const live = await connect(tab.webSocketDebuggerUrl);
await live.send("Page.enable");
const display = await displayOf(live);

let frozen;
const serializeBegan = Date.now();
await withLive(async () => {
  frozen = JSON.parse(await evaluate(live, SERIALIZE(marks), { timeoutMs: 60_000 }));
});
stage("serialize", serializeBegan);
say(`serialized ${frozen.elements} elements, ${frozen.sheets.length} stylesheets, ${frozen.assets.length} assets; marked ${frozen.marked} of ${marks.length} curated boxes`);

// ---- assets: from the tab's cache, else fetched by the page itself ----
const assetsBegan = Date.now();
const cached = new Map();
try {
  const { frameTree } = await live.send("Page.getResourceTree");
  const walk = (node) => {
    for (const resource of node.resources) cached.set(resource.url, { frameId: node.frame.id, mime: resource.mimeType });
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
} catch {}
// Sheets the page could not read (cross-origin, no CORS): the tab's
// cache has them; a public CDN answers a plain fetch otherwise. Their
// url()s are made absolute against the sheet, and their assets collected.
const absolutize = (css, base) => css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (u.startsWith("data:") || u.startsWith("#") ? m : `url("${new URL(u, base).href}")`));
let unreadable = 0;
for (const sheet of frozen.sheets) {
  if (sheet.text !== null || !sheet.href) continue;
  let text = null;
  const hit = cached.get(sheet.href);
  if (hit) {
    try {
      const content = await live.send("Page.getResourceContent", { frameId: hit.frameId, url: sheet.href });
      text = content.base64Encoded ? Buffer.from(content.content, "base64").toString("utf8") : content.content;
    } catch {}
  }
  if (text === null) {
    try {
      const response = await fetch(sheet.href, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) text = await response.text();
    } catch {}
  }
  if (text === null) {
    unreadable += 1;
    continue;
  }
  sheet.text = absolutize(text, sheet.href);
  for (const m of sheet.text.matchAll(/url\("([^"]+)"\)/g)) if (/^https?:/.test(m[1]) && !frozen.assets.includes(m[1])) frozen.assets.push(m[1]);
}
frozen.sheets = frozen.sheets.filter((sheet) => sheet.text !== null);
if (unreadable) say(`${unreadable} stylesheet(s) could not be read from the cache or fetched`);
const sniff = (b) => {
  const head = b.subarray(0, 16);
  const ascii = head.toString("latin1");
  if (head[0] === 0x89 && ascii.startsWith("\x89PNG")) return "png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (ascii.startsWith("GIF8")) return "gif";
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP") return "webp";
  if (ascii.slice(4, 12) === "ftypavif") return "avif";
  if (ascii.startsWith("wOF2")) return "woff2";
  if (ascii.startsWith("wOFF")) return "woff";
  if (ascii.startsWith("OTTO")) return "otf";
  if (head[0] === 0x00 && head[1] === 0x01 && head[2] === 0x00 && head[3] === 0x00) return "ttf";
  if (head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === 0x00) return "ico";
  if (/^\s*(<\?xml|<svg)/i.test(b.subarray(0, 256).toString("utf8"))) return "svg";
  return null;
};
const EXT = { "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf", "application/font-woff2": "woff2", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico" };
// A fresh freeze replaces the last one whole: nothing of an older copy stays to be published.
rmSync(join(workspace, "public", "frozen"), { recursive: true, force: true });
const assetDir = join(workspace, "public", "frozen", "assets");
mkdirSync(assetDir, { recursive: true });
const local = new Map();
let missing = 0;
for (const url of frozen.assets) {
  let bytes = null;
  let mime = cached.get(url)?.mime ?? null;
  const hit = cached.get(url);
  if (hit) {
    try {
      const content = await live.send("Page.getResourceContent", { frameId: hit.frameId, url });
      bytes = Buffer.from(content.content, content.base64Encoded ? "base64" : "utf8");
    } catch {}
  }
  if (!bytes) {
    const got = await evaluate(live, `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then(async r => { if (!r.ok) return null; const b = await r.blob(); const d = await new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.readAsDataURL(b) }); return JSON.stringify({ mime: b.type, b64: String(d).split(',')[1] || '' }) }).catch(() => null)`, { timeoutMs: 30_000 }).catch(() => null);
    if (got) {
      const parsed = JSON.parse(got);
      bytes = Buffer.from(parsed.b64, "base64");
      mime = parsed.mime || mime;
    }
  }
  if (!bytes) {
    // Cross-origin without CORS (a CDN's fonts): a plain request from here.
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        bytes = Buffer.from(await response.arrayBuffer());
        mime = response.headers.get("content-type") || mime;
      }
    } catch {}
  }
  if (!bytes) {
    missing += 1;
    continue;
  }
  const fromPath = (new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i) ?? [])[1];
  // The bytes decide the extension: a CDN's content-type or a URL's suffix
  // can disagree with the file, and publishing checks the file against it.
  const ext = sniff(bytes) ?? EXT[(mime ?? "").split(";")[0]] ?? fromPath ?? "bin";
  const name = `${createHash("sha1").update(url).digest("hex").slice(0, 12)}.${ext}`;
  writeFileSync(join(assetDir, name), bytes);
  local.set(url, name);
}
stage("assets", assetsBegan);
live.close();
say(`saved ${local.size} assets${missing ? `, ${missing} could not be read (they stay remote)` : ""}`);

// ---- the workspace ----
const writeBegan = Date.now();
// Paths are relative, so the copy works wherever it is served: the dev
// server's root and a published snapshot's sub-path alike. The markup
// resolves against the page, a stylesheet against its own folder.
const localize = (text, prefix) => {
  let out = text;
  for (const [url, name] of local) out = out.split(url).join(prefix + name);
  return out;
};
const styleDir = join(workspace, "public", "frozen", "styles");
mkdirSync(styleDir, { recursive: true });
const styles = frozen.sheets.map((sheet, i) => {
  const file = `${String(i).padStart(2, "0")}.css`;
  writeFileSync(join(styleDir, file), localize(sheet.text, "../assets/"));
  return { href: `frozen/styles/${file}`, media: sheet.media || null };
});
const frozenDir = join(workspace, "src", "frozen");
mkdirSync(frozenDir, { recursive: true });
writeFileSync(join(frozenDir, "page.html"), localize(frozen.html, "frozen/assets/"));
writeFileSync(
  join(frozenDir, "frozen.json"),
  JSON.stringify({ url: frozen.url, title: frozen.title, viewport: frozen.viewport, htmlAttrs: frozen.htmlAttrs, bodyAttrs: frozen.bodyAttrs, styles, frozenAt: new Date().toISOString() }, null, 2) + "\n",
);
writeFileSync(join(frozenDir, "Frozen.tsx"), FROZEN_TSX);
writeFileSync(join(workspace, "src", "App.tsx"), APP_TSX);
// The template's baseline would restyle the frozen page; the page brings its own.
writeFileSync(join(workspace, "src", "styles.css"), "/* The frozen page brings its own stylesheets (public/frozen/styles). */\n");
stage("write", writeBegan);

// ---- the check: the workspace in the headless Chrome, box by box against the read ----
const checkBegan = Date.now();
const dev = await ensureDevServer({ workspace, logPath: join(buildDir, "dev.log"), keep: Boolean(options["keep-dev"]) });
const checkDir = join(buildDir, "checks");
mkdirSync(checkDir, { recursive: true });
const viewport = tree.viewport ?? { width: frozen.viewport.width, height: frozen.viewport.height };
const page = await headlessPage(dev.url, { width: viewport.width, height: viewport.height, display });
let measured = [];
let mounted = false;
try {
  for (let i = 0; i < 50 && !mounted; i += 1) {
    mounted = await evaluate(page.page, `Boolean(document.querySelector('[data-pf]'))`);
    if (!mounted) await new Promise((r) => setTimeout(r, 200));
  }
  await evaluate(page.page, `document.fonts.ready.then(() => true)`);
  await new Promise((r) => setTimeout(r, 400));
  measured = JSON.parse(
    await evaluate(page.page, `JSON.stringify(${JSON.stringify(marks.map((m) => m.marker))}.map(marker => { const el = document.querySelector('[data-proto-id="' + marker + '"]'); if (!el) return { marker, found: false }; const r = el.getBoundingClientRect(); return { marker, found: true, rect: { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height } } }))`),
  );
  await stableShot(page.page, `JSON.stringify([innerWidth, innerHeight, document.fonts.status, document.querySelectorAll('[data-pf]').length])`, join(checkDir, "frozen.png"));
} finally {
  await page.close();
  dev.stop();
}
const parts = marks.map((mark) => {
  const node = nodes.get(mark.id);
  const got = measured.find((m) => m.marker === mark.marker);
  const want = node?.rect ?? null;
  let delta = null;
  if (got?.found && want) delta = Math.max(Math.abs(got.rect.x - want.x), Math.abs(got.rect.y - want.y), Math.abs(got.rect.w - want.w), Math.abs(got.rect.h - want.h));
  const status = !got?.found ? "missing" : delta === null || delta <= 1.5 ? "matched" : "moved";
  return { id: mark.id, name: mark.name, marker: mark.marker, role: mark.role, rect: want, status, delta: delta === null ? null : Math.round(delta * 10) / 10 };
});
stage("check", checkBegan);
const off = parts.filter((p) => p.status !== "matched");
say(`checked ${parts.length} marked boxes: ${parts.length - off.length} in place${off.length ? `, ${off.length} off (${off.map((p) => `${p.marker} ${p.status}${p.delta !== null ? ` ${p.delta}px` : ""}`).join(", ")})` : ""}`);

// The site's copy view: each named part's own picture, cut from the
// frozen render, set in at its place as it comes in.
reporter.send([workflowEvent(buildDir, "copy", `Froze ${frozen.elements} elements with the page's own ${styles.length} stylesheets; ${parts.length - off.length} of ${parts.length} named boxes in place`)]);
if (existsSync(join(checkDir, "frozen.png"))) {
  const full = decodePng(readFileSync(join(checkDir, "frozen.png")));
  const scale = full.width / viewport.width;
  await Promise.all(
    parts
      .filter((p) => p.status === "matched" && p.role === "leaf" && p.rect && p.rect.w >= 1 && p.rect.h >= 1)
      .map(async (part) => {
        const x = Math.max(0, Math.round(part.rect.x * scale));
        const y = Math.max(0, Math.round(part.rect.y * scale));
        const width = Math.min(full.width - x, Math.round(part.rect.w * scale));
        const height = Math.min(full.height - y, Math.round(part.rect.h * scale));
        if (width <= 0 || height <= 0) return;
        const image = await reporter.upload(encodePng(cropPng(full, { x, y, width, height }))).catch(() => null);
        if (image) reporter.send([{ kind: "matched", id: part.id, image, rect: part.rect }]);
      }),
  );
}
await reporter.flush();

const result = {
  mode: "freeze",
  mounted,
  elements: frozen.elements,
  stylesheets: styles.length,
  assets: { saved: local.size, missing },
  parts,
  off: off.map((p) => p.marker),
  screenshot: join(checkDir, "frozen.png"),
  seconds: Math.round((Date.now() - began) / 100) / 10,
  timings,
};
writeFileSync(join(buildDir, "freeze.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result));
process.exit(0);
