#!/usr/bin/env node
// Streams a prototype build to the Proto site as it happens, so the user
// watches it in New prototype: the reference page captured, its tree read
// from the root down, curated, each leaf replicated pass by pass, the
// whole checked, the prototype online. Every command sends build events
// through the report_build_events MCP tool; images go up with
// begin_build_capture, so no bytes ever pass through the agent.
//
// The build's local record lives in ~/.proto/<codebase>/run/builds/<briefId>/:
// tree.json is the tree `read` found (node ids, raw labels, boxes, a
// selector per node), which the agent curates and refers to by id.
//
// Usage:
//   node tools/build-stream.mjs read     <briefId> --codebase <id> --page <url-substring> [--port 9333]
//   node tools/build-stream.mjs phase    <briefId> --codebase <id> <phase> "<one sentence>"
//   node tools/build-stream.mjs title    <briefId> --codebase <id> "<prototype title>"
//   node tools/build-stream.mjs name     <briefId> --codebase <id> <curation.json>
//   node tools/build-stream.mjs queue    <briefId> --codebase <id> [nodeId ...]   (no ids: every leaf)
//   node tools/build-stream.mjs pass     <briefId> --codebase <id> <nodeId> <pass> [pixelsOff]
//   node tools/build-stream.mjs matched  <briefId> --codebase <id> <nodeId> [--image <png> --rect x,y,w,h]
//   node tools/build-stream.mjs focus    <briefId> --codebase <id> <nodeId|none>
//   node tools/build-stream.mjs question <briefId> --codebase <id> "<question>"
//
// curation.json is a list: [{ "id": "n3", "name": "Sidebar", "role": "section", "marker": "sidebar" }, ...]
// with role one of section, leaf, packaging, and marker the data-proto-id
// the part becomes in the prototype (none for packaging). Name every node
// read; the site strikes packaging through and replicates leaves.
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { findPage } from "./cdp/attach.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { callTool } from "./mcp-call.mjs";

const PHASES = ["attaching", "reading", "curating", "replicating", "composing", "serving", "ready", "needs-input", "failed"];
const BATCH = 150;
/** The tree is read to this many boxes at most, breadth first. */
const MAX_NODES = 140;
const MAX_DEPTH = 8;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = argv[i + 1];
      i++;
    } else positional.push(arg);
  }
  return { positional, flags };
}

const [command, briefId, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
if (!command || !briefId) fail("usage: node tools/build-stream.mjs <command> <briefId> --codebase <id> ...");
const codebase = flags.codebase;
if (!codebase) fail("--codebase is required: it chooses this laptop's credential for the build");

const runDir = join(process.env.HOME ?? "", ".proto", codebase, "run", "builds", briefId);
const treePath = join(runDir, "tree.json");

/** Sends events to the build's stream, in batches the tool accepts. */
async function report(events) {
  let lastSeq = 0;
  for (let i = 0; i < events.length; i += BATCH) {
    const result = await callTool("report_build_events", { codebase, briefId, events: events.slice(i, i + BATCH) });
    const text = result?.content?.[0]?.text ?? "";
    if (result?.isError) fail(`report_build_events: ${text}`);
    lastSeq = JSON.parse(text).lastSeq ?? lastSeq;
  }
  return lastSeq;
}

/** Uploads one image for the build and returns the address events use. */
async function uploadCapture(bytes, contentType = "image/png") {
  const result = await callTool("begin_build_capture", { codebase, briefId, contentType, size: bytes.length });
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) fail(`begin_build_capture: ${text}`);
  const { uploadUrl, url } = JSON.parse(text);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!res.ok) fail(`the capture upload answered ${res.status}`);
  return url;
}

function readTree() {
  if (!existsSync(treePath)) fail(`no tree for this build yet: run \`read\` first (${treePath})`);
  return JSON.parse(readFileSync(treePath, "utf8"));
}

// The page's tree, breadth first from <body>: every box at least 8px each
// way that shows in the viewport, as tag.class, with a selector to find it
// again. A box whose only child fills it exactly is the child's packaging:
// the chain collapses to the outermost box, its label naming the chain.
const TREE = (maxNodes, maxDepth) => `(() => {
  const vw = innerWidth, vh = innerHeight;
  const label = (el) => {
    const cls = (typeof el.className === "string" ? el.className : "")
      .split(/\\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")).slice(0, 2).join(".");
    return el.tagName.toLowerCase() + (cls ? "." + cls : "");
  };
  const selector = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const parent = e.parentElement;
      const index = parent ? [...parent.children].indexOf(e) + 1 : 1;
      parts.unshift(e.tagName.toLowerCase() + ":nth-child(" + index + ")");
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
  const skip = (c) => ["SCRIPT", "STYLE", "LINK", "META", "NOSCRIPT", "TEMPLATE"].includes(c.tagName);
  // A zero-size wrapper (display: contents, an empty-box layout shell) is
  // not a box, but its children lay out normally: look through it.
  const kids = (el) => [...el.children].filter((c) => !skip(c)).flatMap((c) => {
    const r = c.getBoundingClientRect();
    const s = getComputedStyle(c);
    if ((r.width < 1 || r.height < 1) && s.display !== "none") return kids(c);
    return [c];
  });
  const same = (a, b) => { const p = a.getBoundingClientRect(), q = b.getBoundingClientRect(); return Math.abs(p.x - q.x) < 1 && Math.abs(p.y - q.y) < 1 && Math.abs(p.width - q.width) < 1 && Math.abs(p.height - q.height) < 1; };
  const nodes = [];
  const queue = [{ el: document.body, parent: null, depth: 0 }];
  while (queue.length && nodes.length < ${maxNodes}) {
    let { el, parent, depth } = queue.shift();
    let raw = label(el);
    for (;;) {
      const only = kids(el).filter(shows);
      if (only.length === 1 && same(el, only[0])) { el = only[0]; raw += " > " + label(el); } else break;
    }
    const r = box(el);
    const id = "n" + (nodes.length + 1);
    nodes.push({
      id, parent, depth, raw: raw.length > 110 ? raw.slice(0, 107) + "…" : raw,
      rect: { x: Math.max(0, r.x), y: Math.max(0, r.y), w: Math.min(r.w, vw - Math.max(0, r.x)), h: Math.min(r.h, vh - Math.max(0, r.y)) },
      selector: selector(el),
      protoId: el.getAttribute("data-proto-id"),
      text: kids(el).length === 0 ? (el.innerText || "").trim().slice(0, 40) : null,
    });
    if (depth + 1 < ${maxDepth}) for (const child of kids(el).filter(shows)) queue.push({ el: child, parent: id, depth: depth + 1 });
  }
  return JSON.stringify({ viewport: { width: vw, height: vh, dpr: devicePixelRatio }, url: location.href, nodes });
})()`;

switch (command) {
  case "read": {
    const match = flags.page;
    if (!match) fail("--page <url-substring> names the reference tab in the Proto window");
    const port = Number(flags.port ?? 9333);
    await report([{ kind: "phase", phase: "attaching", line: "Opening your page in the Proto window" }]);
    const tab = await findPage(match, port).catch(() => null);
    if (!tab) fail(`no tab in the Proto window (port ${port}) matches "${match}"`);
    const page = await connect(tab.webSocketDebuggerUrl);
    const read = JSON.parse(await evaluate(page, TREE(MAX_NODES, MAX_DEPTH)));
    const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    page.close();
    const image = await uploadCapture(Buffer.from(shot.data, "base64"));
    mkdirSync(runDir, { recursive: true });
    writeFileSync(treePath, JSON.stringify(read, null, 2));
    const { viewport, nodes } = read;
    const events = [
      { kind: "reference", image, url: read.url, width: viewport.width, height: viewport.height },
      { kind: "phase", phase: "reading", line: "Reading the page's structure, root first" },
    ];
    nodes.forEach((node, index) => {
      if (index % 3 === 0) events.push({ kind: "focus", id: node.id });
      events.push({ kind: "found", id: node.id, parent: node.parent, raw: node.raw, rect: node.rect });
    });
    events.push({ kind: "focus", id: null });
    await report(events);
    console.log(`read ${nodes.length} boxes from ${read.url} (viewport ${viewport.width}×${viewport.height}); tree at ${treePath}`);
    console.log("next: write curation.json naming every node (section, leaf or packaging), then run `name`.");
    break;
  }
  case "phase": {
    const [phase, line] = positional;
    if (!PHASES.includes(phase) || !line) fail(`phase needs one of ${PHASES.join(", ")} and a sentence`);
    await report([{ kind: "phase", phase, line }]);
    break;
  }
  case "title": {
    const [title] = positional;
    if (!title) fail("title needs the prototype's title");
    await report([{ kind: "titled", title }]);
    break;
  }
  case "name": {
    const [file] = positional;
    if (!file) fail("name needs the curation file");
    const tree = readTree();
    const known = new Set(tree.nodes.map((node) => node.id));
    const curation = JSON.parse(readFileSync(file, "utf8"));
    const events = [{ kind: "phase", phase: "curating", line: "Naming sections, dropping the packaging" }];
    for (const entry of curation) {
      if (!known.has(entry.id)) fail(`curation names ${entry.id}, which \`read\` did not find`);
      if (!["section", "leaf", "packaging"].includes(entry.role)) fail(`${entry.id}: role must be section, leaf or packaging`);
      const named = { kind: "named", id: entry.id, name: entry.name, role: entry.role };
      if (entry.marker) named.marker = entry.marker;
      events.push(named);
    }
    tree.curation = curation;
    writeFileSync(treePath, JSON.stringify(tree, null, 2));
    await report(events);
    console.log(`named ${curation.length} of ${tree.nodes.length} boxes`);
    break;
  }
  case "queue": {
    const tree = readTree();
    let ids = positional;
    if (ids.length === 0) ids = (tree.curation ?? []).filter((entry) => entry.role === "leaf").map((entry) => entry.id);
    if (ids.length === 0) fail("nothing to queue: name the tree first, or pass node ids");
    await report([
      { kind: "phase", phase: "replicating", line: `Replicating ${ids.length} leaves against your page` },
      ...ids.map((id) => ({ kind: "queued", id })),
    ]);
    break;
  }
  case "pass": {
    const [id, pass, off] = positional;
    if (!id || !pass) fail("pass needs a node id and the pass number");
    await report([
      { kind: "focus", id },
      { kind: "pass", id, pass: Number(pass), mismatch: off === undefined ? null : Number(off) },
    ]);
    break;
  }
  case "matched": {
    const [id] = positional;
    if (!id) fail("matched needs a node id");
    const event = { kind: "matched", id };
    if (flags.image) {
      if (!existsSync(flags.image) || statSync(flags.image).size === 0) fail(`no image at ${flags.image}`);
      event.image = await uploadCapture(readFileSync(flags.image));
      if (flags.rect) {
        const [x, y, w, h] = flags.rect.split(",").map(Number);
        event.rect = { x, y, w, h };
      }
    }
    await report([event]);
    break;
  }
  case "focus": {
    const [id] = positional;
    await report([{ kind: "focus", id: id && id !== "none" ? id : null }]);
    break;
  }
  case "question": {
    const [text] = positional;
    if (!text) fail("question needs the question");
    await report([{ kind: "question", text }]);
    break;
  }
  default:
    fail(`unknown command ${command}`);
}
