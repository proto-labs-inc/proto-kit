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
 *       report_sketch: one event or an array (at most 12), shown at once
 *   node tools/sketch.mjs status --brief <id> "<what you are doing>"
 *   node tools/sketch.mjs wait --brief <id> [--after <seq>] [--minutes 9]
 *       waits for the person's next choices and prints
 *       {person: [...], lastSeq, sketch}; --after defaults to the last
 *       seq this command returned for the brief
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

async function post(flags) {
  const source = flags._[0];
  if (!source) throw new Error("post needs a JSON file (or - for stdin)");
  const text = source === "-" ? readFileSync(0, "utf8") : readFileSync(source, "utf8");
  const parsed = JSON.parse(text);
  const events = Array.isArray(parsed) ? parsed : [parsed];
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
    case "read": {
      const brief = await tool("get_brief", { briefId: flags.brief });
      return console.log(JSON.stringify(brief.sketch ?? null, null, 2));
    }
    default:
      throw new Error("usage: sketch.mjs candidates|post|status|wait|read --brief <id> …");
  }
}

main().catch((error) => {
  console.error(`sketch: ${error.message}`);
  process.exit(1);
});
