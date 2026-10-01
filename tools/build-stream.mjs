#!/usr/bin/env node
// Streams a prototype build to the Proto site as it happens, so the user
// watches it in New prototype: the reference page captured, its tree read
// from the root down, curated, each leaf replicated pass by pass, the
// whole checked, the prototype online. Every command sends build events
// through the report_build_events MCP tool; images go up with
// begin_build_capture, so no bytes ever pass through the agent.
//
// The build's local record lives in ~/.proto/<codebase>/run/builds/<briefId>/:
//   tree.json     the tree `read` found (node ids, raw labels, boxes, a
//                 selector and element index per node); the agent
//                 curates it and refers to nodes by id
//   read.json     every element of the page with its computed style, the
//                 page's tokens and image urls (tools/read-page.mjs)
//   assets/       the page's font files and images
//   curation.json the draft `curate` wrote and the agent reviewed
// Nothing after `read` reads the live page again except the checks.
//
// Usage:
//   node tools/build-stream.mjs read     <briefId> --codebase <id> --page <url-substring> [--port 9333]
//   node tools/build-stream.mjs curate   <briefId> --codebase <id>
//   node tools/build-stream.mjs phase    <briefId> --codebase <id> <phase> "<one sentence>"
//   node tools/build-stream.mjs title    <briefId> --codebase <id> "<prototype title>"
//   node tools/build-stream.mjs name     <briefId> --codebase <id> <curation.json>
//   node tools/build-stream.mjs queue    <briefId> --codebase <id> [nodeId ...]   (no ids: every leaf)
//   node tools/build-stream.mjs pass     <briefId> --codebase <id> <nodeId> <pass> [pixelsOff]
//   node tools/build-stream.mjs matched  <briefId> --codebase <id> <nodeId> [--image <png> --rect x,y,w,h]
//   node tools/build-stream.mjs focus    <briefId> --codebase <id> <nodeId|none>
//   node tools/build-stream.mjs question <briefId> --codebase <id> --kind copy-gate|generic "<question>"
//                                [--detail "…"] [--impact "…"] --option id="Label" --option id="Label" [--option …]
//                                [--recommended <id>] [--suggest "…"]…
//                                [--copied <0-100>] [--missing <nodeId>,…]
//       prints a needs-input JSON record, or the already-persisted answer
//   node tools/build-stream.mjs await-answer <briefId> <questionId> --codebase <id>
//       reads the durable answer or returns needs-input immediately
//       { by: option|reply, option?, text? }
//   node tools/build-stream.mjs answered <briefId> <questionId> --codebase <id> --text "<what they said>" | --option <id>
//       records the answer from the current conversation
// Questions return promptly and never select a default answer.
// --question-key <stable-key> distinguishes repeated identical chat questions.
// Every command takes --no-send: events go to <build>/events.jsonl and
// images to <build>/captures/ instead of the site (a build under test).
//
// curation.json is a list: [{ "id": "n3", "name": "Sidebar", "role": "section", "marker": "sidebar" }, ...]
// with role one of section, leaf, packaging, and marker the data-proto-id
// the part becomes in the prototype (none for packaging). Name every node
// read; the site strikes packaging through and replicates leaves.
//
// Questions are answered explicitly in the current conversation.
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPage } from "./cdp/attach.mjs";
import { connect } from "./cdp/cdp.mjs";
import { takeFrame } from "./cdp/live.mjs";
import { answeredInTerminal, ask, waitForAnswer } from "./ask.mjs";
import { createReporter } from "./build-report.mjs";
import { draftCuration } from "./curate.mjs";
import { captureAssets, overlayLine, readPage } from "./read-page.mjs";

const PHASES = ["attaching", "reading", "curating", "replicating", "composing", "serving", "ready", "needs-input", "failed"];

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Flags a command takes more than once: each one adds to a list.
const REPEATED = new Set(["option", "suggest"]);

function parseArgs(argv) {
  const positional = [];
  const flags = { option: [], suggest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-send") flags.noSend = true;
    else if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (REPEATED.has(key)) flags[key].push(argv[i + 1]);
      else flags[key] = argv[i + 1];
      i++;
    } else positional.push(arg);
  }
  return { positional, flags };
}

/** "id=Label" -> { id, label }. */
function optionOf(spec) {
  const at = spec?.indexOf("=") ?? -1;
  if (at <= 0) fail(`--option takes id="Label", not ${spec}`);
  return { id: spec.slice(0, at), label: spec.slice(at + 1) };
}

/** A numeric flag, or undefined when it was not given. */
function numberFlag(name) {
  if (flags[name] === undefined) return undefined;
  const value = Number(flags[name]);
  if (!Number.isFinite(value)) fail(`--${name} takes a number, not ${flags[name]}`);
  return value;
}

const [command, briefId, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
if (!command || !briefId) fail("usage: node tools/build-stream.mjs <command> <briefId> --codebase <id> ...");
const codebase = flags.codebase;
if (!codebase) fail("--codebase is required: it chooses this laptop's credential for the build");

const runDir = join(process.env.HOME ?? "", ".proto", codebase, "run", "builds", briefId);
const treePath = join(runDir, "tree.json");
const readPath = join(runDir, "read.json");
const curationPath = join(runDir, "curation.json");
const sink = flags.noSend ? "file" : "site";
const build = { codebase, briefId, runDir, sink, questionKey: flags["question-key"] };

const reporter = createReporter({ codebase, briefId, runDir, sink });
/** Sends events to the build's stream and waits for them to leave. */
async function report(events) {
  reporter.send(events);
  await reporter.flush();
}
const uploadCapture = (bytes) => reporter.upload(bytes);

function readTree() {
  if (!existsSync(treePath)) fail(`no tree for this build yet: run \`read\` first (${treePath})`);
  return JSON.parse(readFileSync(treePath, "utf8"));
}

switch (command) {
  case "read": {
    const match = flags.page;
    if (!match) fail("--page <url-substring> names the reference tab in the Proto window");
    const port = Number(flags.port ?? 9333);
    const started = Date.now();
    const took = () => `${((Date.now() - started) / 1000).toFixed(1)} s`;
    await report([{ kind: "phase", phase: "attaching", line: "Opening your page in the Proto window" }]);
    const tab = await findPage(match, port).catch(() => null);
    if (!tab) fail(`no tab in the Proto window (port ${port}) matches "${match}"`);
    const page = await connect(tab.webSocketDebuggerUrl);
    mkdirSync(runDir, { recursive: true });
    // One lock, one frame: the resting page is captured for the checks
    // to cut from, and the whole page is read under the same lock, so
    // nothing reads the live page again until the checks.
    let read;
    let frame;
    try {
      frame = await takeFrame(page, codebase, { also: () => readPage(page) });
      read = frame.read;
      console.error(`… read ${read.read.elements.length} elements and ${read.tree.nodes.length} boxes (${took()})`);
      if (read.tree.overlay) console.error(`… ${overlayLine(read.tree.overlay)}`);
      const captured = await captureAssets(page, read.read, join(runDir, "assets"));
      read.read.faces = captured.faces;
      read.read.assets = captured.assets;
      console.error(`… saved ${captured.faces.length} font faces and ${Object.keys(captured.assets).length} images (${took()})`);
    } finally {
      page.close();
    }
    const image = await uploadCapture(readFileSync(frame.png));
    writeFileSync(treePath, JSON.stringify(read.tree, null, 2));
    writeFileSync(readPath, JSON.stringify(read.read));
    const { viewport, nodes } = read.tree;
    const events = [
      { kind: "reference", image, url: read.tree.url, width: viewport.width, height: viewport.height },
      { kind: "phase", phase: "reading", line: read.tree.overlay ? `Reading the page's structure, root first; ${overlayLine(read.tree.overlay)}` : "Reading the page's structure, root first" },
    ];
    nodes.forEach((node, index) => {
      if (index % 3 === 0) events.push({ kind: "focus", id: node.id });
      events.push({ kind: "found", id: node.id, parent: node.parent, raw: node.raw, rect: node.rect });
    });
    events.push({ kind: "focus", id: null });
    await report(events);
    const folded = nodes.filter((node) => node.collapsed).length;
    console.log(`read ${nodes.length} boxes (${folded} holding repeated parts) from ${read.tree.url} (viewport ${viewport.width}×${viewport.height}) in ${took()}; tree at ${treePath}`);
    if (read.tree.overlay) console.log(`dialog: ${overlayLine(read.tree.overlay)} (backdrop ${read.tree.overlay.backdrop ?? "not in the tree"}, dialog ${read.tree.overlay.dialog ?? "not in the tree"})`);
    console.log("next: `curate` drafts curation.json; review it, then run `name`.");
    break;
  }
  case "curate": {
    const tree = readTree();
    const curation = draftCuration(tree);
    writeFileSync(curationPath, JSON.stringify(curation, null, 2) + "\n");
    const count = (role) => curation.filter((entry) => entry.role === role).length;
    console.log(`drafted ${curation.length} entries: ${count("section")} sections, ${count("leaf")} leaves, ${count("packaging")} packaging; at ${curationPath}`);
    console.log("review the names and roles, then run `name` with this file.");
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
    if (file !== curationPath) copyFileSync(file, curationPath);
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
    if (!flags.kind) fail("question needs --kind copy-gate or --kind generic");
    const fields = {
      form: flags.kind,
      text,
      detail: flags.detail,
      impact: flags.impact,
      options: flags.option.map(optionOf),
      recommended: flags.recommended,
      suggestions: flags.suggest,
      copied: numberFlag("copied"),
      missing: flags.missing === undefined ? undefined : flags.missing.split(",").map((id) => id.trim()).filter(Boolean),
    };
    const questionId = await ask(build, fields).catch((error) => fail(error.message));
    console.log(JSON.stringify(await waitForAnswer(build, questionId)));
    break;
  }
  case "await-answer": {
    const [questionId] = positional;
    if (!questionId) fail("await-answer needs the question id `question` printed");
    const answer = await waitForAnswer(build, questionId).catch((error) => fail(error.message));
    console.log(JSON.stringify(answer));
    break;
  }
  case "answered": {
    const [questionId] = positional;
    if (!questionId || (flags.text !== undefined) === (flags.option.length > 0) || flags.option.length > 1) fail('answered needs the question id and exactly one --text "<what the person said>" or --option <id>');
    const answer = await answeredInTerminal(build, questionId, flags.option.length ? { option: flags.option[0] } : { text: flags.text }).catch((error) => fail(error.message));
    console.log(JSON.stringify(answer));
    break;
  }
  default:
    fail(`unknown command ${command}`);
}
