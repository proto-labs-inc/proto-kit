#!/usr/bin/env node
/**
 * The sketch before a new prototype's build (docs/sketch.md): the agent's
 * side of it, so the agent never hand-writes an MCP call or a poll loop.
 *
 * Usage:
 *   node tools/sketch.mjs candidates --brief <id> [--recent "<words>"]... [--mobbin <topic|page>]... [--limit <n>]
 *       reference candidates from Recent and Mobbin, read in parallel:
 *       writes them to <dir>/candidates.json and a numbered contact sheet
 *       to <dir>/sheet.png (read it to judge relevance in one look), and
 *       prints one line per candidate: n, source, title, app, description
 *   node tools/sketch.mjs post --brief <id> <events.json | ->
 *       report_sketch: one event or an array (at most 12), shown at once.
 *       A wireframe may be written as changes to another one, so a
 *       direction only says what is new (docs/sketch.md, "Changes"):
 *       {"from": "base", "changes": [{"replace": "<id>", "with": <part>},
 *        {"after"|"before": "<id>", "add": <part>}, {"into": "<id>", "add": <part>, "at": <n>},
 *        {"remove": "<id>"}, {"set": "<id>", "to": {<fields>}}]}
 *       "from" names base.json or another drawn take or option in <dir>
 *   node tools/sketch.mjs status --brief <id> "<what you are doing>"
 *   node tools/sketch.mjs wait --brief <id> [--after <seq>] [--minutes 9]
 *       waits for the person's next choices and prints
 *       {person: [...], lastSeq, sketch}; --after defaults to the last
 *       seq this command returned for the brief
 *   node tools/sketch.mjs base --brief <id> [--from <take id>]
 *       the drawing a direction (or a moment) starts from, once it exists:
 *       waits for it (up to 3 minutes, checking every second), then
 *       prints its part ids and its path
 *   node tools/sketch.mjs read --brief <id>
 *       the sketch as it stands (get_brief's sketch), without waiting
 *
 * <dir> is ~/.proto/sketches/<briefId>/.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { callTool } from "./mcp-call.mjs";

const run = promisify(execFile);
const KIT = fileURLToPath(new URL(".", import.meta.url));

function dirOf(briefId) {
  const dir = join(process.env.HOME ?? ".", ".proto", "sketches", briefId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The JSON a tool answered with, or its error as an exception. */
async function tool(name, args) {
  const result = await callTool(name, args);
  const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
  if (result?.isError) {
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {
      // Plain text error.
    }
    throw new Error(`${name}: ${message}`);
  }
  return JSON.parse(text);
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1] === undefined || argv[i + 1].startsWith("--") ? true : argv[++i];
    flags[key] = flags[key] === undefined ? value : [flags[key], value].flat();
  }
  return flags;
}

const list = (value) => (value === undefined ? [] : [value].flat());

async function lines(file, args) {
  try {
    const { stdout } = await run(process.execPath, [join(KIT, file), ...args], { maxBuffer: 16 * 1024 * 1024 });
    return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    console.error(`${file}: ${(error.stderr || error.message).trim()}`);
    return [];
  }
}

async function candidates(flags) {
  const dir = dirOf(flags.brief);
  const limit = String(flags.limit ?? 8);
  const [recent, mobbin] = await Promise.all([
    Promise.all(list(flags.recent).map((words) => lines("recent.mjs", ["search", words, "--limit", limit]))),
    list(flags.mobbin).length ? lines("mobbin.mjs", ["cards", ...list(flags.mobbin), "--limit", String(Math.ceil(Number(limit) / 2))]) : [],
  ]);
  const seen = new Set();
  const all = [...recent.flat(), ...mobbin].filter((c) => !seen.has(c.url) && seen.add(c.url));
  if (all.length === 0) throw new Error("no candidates: try other words or topics");
  const numbered = all.map((c, index) => ({ n: index + 1, ...c }));
  writeFileSync(join(dir, "candidates.json"), JSON.stringify(numbered, null, 2));
  for (const c of numbered) {
    console.log(`${c.n}. [${c.source}] ${c.title}${c.app ? ` (${c.app})` : ""}${c.description ? ` - ${c.description.slice(0, 140)}` : ""}`);
  }
  const sheet = await contactSheet(numbered, join(dir, "sheet.png")).catch((error) => {
    console.error(`contact sheet: ${error.message}`);
    return null;
  });
  if (sheet) console.log(`\nContact sheet: ${sheet}`);
  console.log(`Candidates: ${join(dir, "candidates.json")}`);
}

/** Every candidate in one numbered picture, so relevance is judged in
 *  one look rather than one image at a time. */
async function contactSheet(items, out) {
  const { headlessPage } = await import("./cdp/headless.mjs");
  const cells = items
    .map(
      (c) => `<figure><img src="${c.image}" referrerpolicy="no-referrer"><figcaption><b>${c.n}</b> ${escape(c.title)}${c.app ? ` · ${escape(c.app)}` : ""} <i>${c.source}</i></figcaption></figure>`,
    )
    .join("");
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:16px;background:#f4f2ed;font:14px system-ui;display:grid;grid-template-columns:repeat(4,1fr);gap:14px}
    figure{margin:0;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0002}
    img{display:block;width:100%;height:220px;object-fit:cover;object-position:top}
    figcaption{padding:6px 8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    b{display:inline-block;min-width:22px;background:#3b4bf5;color:#fff;border-radius:11px;text-align:center;margin-right:4px}
    i{color:#888;font-style:normal;font-size:12px}</style>${cells}`;
  const rows = Math.ceil(items.length / 4);
  const height = 32 + rows * 270;
  const { page, close } = await headlessPage(`data:text/html;base64,${Buffer.from(html).toString("base64")}`, { width: 1400, height });
  try {
    const { result } = await page.send("Runtime.evaluate", {
      expression: "Promise.all([...document.images].map(i => i.complete ? 1 : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 6000); })))",
      awaitPromise: true,
    });
    void result;
    const shot = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 70, captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1400, height, scale: 0.6 } });
    writeFileSync(out, Buffer.from(shot.data, "base64"));
    return out;
  } finally {
    await close();
  }
}

function escape(text) {
  return String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
}

/** A wireframe written as changes, made whole: the drawing it starts
 *  from (<dir>/<from>.json, a bare wireframe or an event holding one),
 *  with each change applied by part id. */
export function applyChanges(base, changes) {
  const root = structuredClone(base.root);
  const find = (node, id, parent = null) => {
    if (node.id === id) return { node, parent };
    for (const child of node.children ?? []) {
      const hit = find(child, id, node);
      if (hit) return hit;
    }
    return null;
  };
  const must = (id) => {
    if (typeof id !== "string") {
      throw new Error(`a change names a part by its id (a string), not ${JSON.stringify(id).slice(0, 60)}: write {"after": "<id>", "add": <part>}, {"replace": "<id>", "with": <part>}, {"set": "<id>", "to": {…}}`);
    }
    const hit = find(root, id);
    if (!hit) throw new Error(`no part with id "${id}" to change; ids in the base: ${ids(root).join(", ")}`);
    return hit;
  };
  for (const change of changes) {
    if (change.replace) {
      const { node, parent } = must(change.replace);
      if (!parent) Object.assign(root, change.with);
      else parent.children[parent.children.indexOf(node)] = change.with;
    } else if (change.after || change.before) {
      const { node, parent } = must(change.after ?? change.before);
      if (!parent) throw new Error("cannot add beside the root");
      const at = parent.children.indexOf(node) + (change.after ? 1 : 0);
      parent.children.splice(at, 0, change.add);
    } else if (change.into) {
      const { node } = must(change.into);
      node.children ??= [];
      node.children.splice(change.at ?? node.children.length, 0, change.add);
    } else if (change.remove) {
      const { node, parent } = must(change.remove);
      if (parent) parent.children.splice(parent.children.indexOf(node), 1);
    } else if (change.set) {
      Object.assign(must(change.set).node, change.to);
    } else {
      throw new Error(`a change needs replace, after, before, into, remove or set: ${JSON.stringify(change).slice(0, 120)}`);
    }
  }
  return { frame: base.frame, root };
}

function ids(node, out = []) {
  if (node.id) out.push(node.id);
  for (const child of node.children ?? []) ids(child, out);
  return out;
}

export function wireframeIn(dir, name) {
  const file = join(dir, name.endsWith(".json") ? name : `${name}.json`);
  if (!existsSync(file)) throw new Error(`from "${name}": ${file} does not exist`);
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.root) return data;
  // A take or option written as changes to another drawing.
  if (data.wireframe) return resolveWireframe(dir, data.wireframe);
  throw new Error(`from "${name}": ${file} holds no wireframe`);
}

function resolveWireframe(dir, wireframe) {
  if (!wireframe?.from) return wireframe;
  return applyChanges(wireframeIn(dir, wireframe.from), wireframe.changes ?? []);
}

/** Every wireframe in an event made whole, in parts the site knows. */
function resolveEvent(dir, event) {
  if (event.wireframe) return { ...event, wireframe: normalizeWireframe(resolveWireframe(dir, event.wireframe)) };
  if (event.options) return { ...event, options: event.options.map((option) => ({ ...option, wireframe: normalizeWireframe(resolveWireframe(dir, option.wireframe)) })) };
  return event;
}

const PARTS = new Set(["row", "col", "overlay", "text", "button", "input", "select", "search", "toggle", "checkbox", "radio", "chip", "badge", "avatar", "icon", "divider", "spacer", "image", "chart", "table", "list", "tabs", "code", "nav"]);
/** Names a sketcher reaches for, as the part the site draws for them. */
const ALIASES = {
  stack: { t: "col" }, vstack: { t: "col" }, column: { t: "col" }, section: { t: "col" }, container: { t: "col" }, group: { t: "col" }, form: { t: "col" }, page: { t: "col" },
  hstack: { t: "row" }, header: { t: "row" }, toolbar: { t: "row" }, footer: { t: "row" },
  card: { t: "col", box: "line" }, panel: { t: "col", box: "line" }, box: { t: "col", box: "line" }, banner: { t: "row", box: "line" }, callout: { t: "row", box: "soft" }, alert: { t: "row", box: "line" },
  modal: { t: "overlay", kind: "modal" }, dialog: { t: "overlay", kind: "modal" }, drawer: { t: "overlay", kind: "drawer" }, popover: { t: "overlay", kind: "popover" }, toast: { t: "overlay", kind: "toast" }, sheet: { t: "overlay", kind: "sheet" },
  heading: { t: "text", size: "lg" }, title: { t: "text", size: "lg" }, h1: { t: "text", size: "xl" }, h2: { t: "text", size: "lg" }, label: { t: "text", size: "sm" }, paragraph: { t: "text" }, caption: { t: "text", size: "xs", muted: true }, link: { t: "button", style: "ghost" },
  textarea: { t: "input" }, dropdown: { t: "select" }, switch: { t: "toggle" }, tag: { t: "chip" }, pill: { t: "chip" }, status: { t: "badge" },
  img: { t: "image" }, picture: { t: "image" }, graph: { t: "chart" }, sidebar: { t: "nav" }, menu: { t: "list" }, separator: { t: "divider" }, hr: { t: "divider" },
};
const LABELLED = new Set(["button", "chip", "badge"]);

/** A wireframe in parts the site knows: aliases mapped, blanks filled,
 *  anything else drawn as a dashed box named after it, so a sketch is
 *  never refused for a word. */
export function normalizeWireframe(wireframe) {
  const fix = (node) => {
    if (!node || typeof node !== "object") return { t: "spacer" };
    let next = { ...node };
    const alias = ALIASES[String(next.t ?? "").toLowerCase()];
    if (alias) next = { ...alias, ...next, t: alias.t, ...(alias.kind && !next.kind ? { kind: alias.kind } : {}) };
    if (!PARTS.has(next.t)) {
      const name = String(next.t ?? "part");
      const text = next.label ?? next.text ?? name;
      next = { t: "col", box: "dashed", ...(next.id ? { id: next.id } : {}), ...(next.hl ? { hl: true } : {}), ...(next.note ? { note: next.note } : {}), children: next.children ?? [{ t: "text", text: String(text).slice(0, 160), size: "sm" }] };
    }
    if (next.t === "text" && !next.text && !next.lines) next.lines = 1;
    if (LABELLED.has(next.t) && !next.label) next.label = next.text ?? (next.t === "button" ? "Button" : "Label");
    for (const key of ["label", "value", "title", "note", "text", "brand"]) if (next[key] === "") delete next[key];
    if (next.t === "overlay" && !next.kind) next.kind = "modal";
    if ((next.t === "row" || next.t === "col" || next.t === "overlay") && !Array.isArray(next.children)) next.children = [];
    if (Array.isArray(next.children)) next.children = next.children.map(fix);
    return next;
  };
  return { frame: wireframe.frame === "mobile" ? "mobile" : "desktop", root: fix(wireframe.root) };
}

async function post(flags) {
  const source = flags._[0];
  if (!source) throw new Error("post needs a JSON file (or - for stdin)");
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const parsed = JSON.parse(text);
  const dir = dirOf(flags.brief);
  if (!Array.isArray(parsed) && parsed.root && !parsed.type) {
    throw new Error("this is a bare drawing (the base): it is never posted. Write it to base.json and stop; the directions are posted as changes to it.");
  }
  const events = (Array.isArray(parsed) ? parsed : [parsed]).map((event) => resolveEvent(dir, event));
  for (let i = 0; i < events.length; i += 12) {
    const answer = await tool("report_sketch", { briefId: flags.brief, events: events.slice(i, i + 12) });
    console.log(JSON.stringify(answer));
  }
}

async function wait(flags) {
  const dir = dirOf(flags.brief);
  const seqFile = join(dir, "seq");
  let after = flags.after !== undefined ? Number(flags.after) : existsSync(seqFile) ? Number(readFileSync(seqFile, "utf8")) : 0;
  const until = Date.now() + Number(flags.minutes ?? 9) * 60_000;
  for (;;) {
    const left = Math.max(0, Math.min(50, Math.floor((until - Date.now()) / 1000)));
    const answer = await tool("read_sketch", { briefId: flags.brief, after, waitSeconds: left });
    after = answer.lastSeq;
    writeFileSync(seqFile, String(after));
    if (answer.person.length > 0 || left === 0) {
      console.log(JSON.stringify(answer, null, 2));
      if (answer.person.length === 0) console.error("No choice yet: the person is still looking. Run wait again.");
      return;
    }
  }
}

/** Waits for the drawing a sketcher starts from, then names its parts. */
async function base(flags) {
  const dir = dirOf(flags.brief);
  const name = typeof flags.from === "string" ? flags.from : "base";
  const until = Date.now() + 3 * 60_000;
  while (!existsSync(join(dir, `${name}.json`))) {
    if (Date.now() > until) throw new Error(`${name}.json did not appear in 3 minutes: draw from the brief without it`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // A file being written may not parse yet.
  for (;;) {
    try {
      const drawing = wireframeIn(dir, name);
      console.log(`${join(dir, `${name}.json`)}\nids: ${ids(drawing.root).join(", ")}`);
      return;
    } catch (error) {
      // Only a file still being written is worth waiting for.
      if (!(error instanceof SyntaxError) || Date.now() > until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (!flags.brief) throw new Error("--brief <briefId> is required");
  switch (command) {
    case "candidates":
      return candidates(flags);
    case "post":
      return post(flags);
    case "status":
      return console.log(JSON.stringify(await tool("report_sketch", { briefId: flags.brief, events: [{ type: "status", line: flags._.join(" ") }] })));
    case "wait":
      return wait(flags);
    case "base":
      return base(flags);
    case "read": {
      const brief = await tool("get_brief", { briefId: flags.brief });
      return console.log(JSON.stringify(brief.sketch ?? null, null, 2));
    }
    default:
      throw new Error("usage: sketch.mjs candidates|post|status|wait|read --brief <id> …");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`sketch: ${error.message}`);
    process.exit(1);
  });
}
