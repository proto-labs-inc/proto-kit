#!/usr/bin/env node
/**
 * The whole copy of the reference page in one command, so the agent
 * runs one tool before writing the change: the read of the page, the
 * title, the drafted curation, the naming, the workspace and the
 * replicated page, each step's events streamed to the site by the tool
 * that takes it. Prints the parts list the agent edits from.
 *
 * Usage:
 *   node tools/proto-build.mjs <briefId> --codebase <id> --page <url-substring> --slug <slug> --title "<title>"
 *                              [--accept-curation] [--again] [--keep-dev] [--lanes 12] [--retry-mode full|failing] [--no-send] [--port 9333]
 *
 * Every step is skipped when its output already exists in the build
 * folder (~/.proto/<codebase>/run/builds/<briefId>/), so the same
 * command continues a build where it stopped:
 *   read       tree.json, read.json, assets/     build-stream.mjs read
 *   title      steps.json records it             build-stream.mjs title
 *   curate     curation.json                     build-stream.mjs curate
 *              The command stops here the first time and prints the
 *              leaves and sections it drafted, so names that read as
 *              "Group" or "Block" get fixed before they become markers
 *              (comment anchors, kept for the prototype's life). Run
 *              the same command again to continue; --accept-curation
 *              goes straight through.
 *   name       tree.json carries the curation     build-stream.mjs name
 *   scaffold   workspace.json                     scaffold.mjs (idempotent)
 *   replicate  parts.json                         replicate.mjs (--again redoes it)
 *   gate       steps.json records the decision    copy-gate.mjs
 *              A copy over its gate (the page differs by more than
 *              TAIL.PAGE_PROCEED_PCT, or did not mount) is copied once
 *              more after the page settles; still over, the person is
 *              asked whether to start building anyway. The command
 *              returns needs-input immediately; record the chat answer
 *              with build-stream answered, then rerun without --again.
 *
 * Then it sends `phase composing` and prints parts.json: one JSON
 * line with the workspace, every part (its node id, name, marker, the
 * files in src/parts/<slug>/, whether it came from the library, its
 * check's status, its rect on the page and the section it sits in),
 * every section, what is left to fix, the page's own verdict, and the
 * gate: { outcome: proceed | build | reply, line, answer?, instruction? },
 * where a reply's instruction is what the person wrote, to follow as given.
 * --keep-dev leaves the workspace's dev server up for the checks that
 * follow; without it the serve skill's run starts it again.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFolder } from "./build-folder.mjs";
import { ask, waitForAnswer } from "./ask.mjs";
import { workflowEvent } from "./workflow-report.mjs";
import { createReporter } from "./build-report.mjs";
import { findPage } from "./cdp/attach.mjs";
import { connect } from "./cdp/cdp.mjs";
import { takeFrame } from "./cdp/live.mjs";
import { liveMatchOf } from "./check.mjs";
import { passGate } from "./copy-gate.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const tools = join(kit, "tools");
const started = Date.now();
// Long enough for what the page animates on its own (a carousel's
// turn, a toast leaving) to finish before it is captured again.
const SETTLE_MS = 3_000;

const USAGE = 'usage: node tools/proto-build.mjs <briefId> --codebase <id> --page <url-substring> --slug <slug> --title "<title>" [--accept-curation] [--again] [--keep-dev] [--lanes 12] [--retry-mode full|failing] [--no-send]';

const options = { lanes: "12", port: "9333", "retry-mode": "failing" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (["--no-send", "--accept-curation", "--again", "--keep-dev"].includes(args[i])) options[args[i].slice(2)] = true;
  else if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [briefId] = positional;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!briefId || !options.codebase || !options.slug) fail(USAGE);
if (!["full", "failing"].includes(options["retry-mode"])) fail("--retry-mode must be full or failing");
const codebase = options.codebase;
const buildDir = buildFolder(codebase, briefId);
const at = (name) => join(buildDir, name);
const stepsPath = at("steps.json");
const steps = existsSync(stepsPath) ? JSON.parse(readFileSync(stepsPath, "utf8")) : {};
const timings = {};
const say = (line) => console.error(`proto-build: ${line}`);

/** One kit tool as its own process: its progress goes to stderr, its JSON line comes back. */
function run(tool, toolArgs, { json = false, sends = true } = {}) {
  const began = Date.now();
  const noSend = sends && options["no-send"] ? ["--no-send"] : [];
  const result = spawnSync(process.execPath, [join(tools, tool), ...toolArgs, ...noSend], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`${tool} ${toolArgs[0]} failed (exit ${result.status})`);
  timings[`${tool.replace(/\.mjs$/, "")}${json ? "" : `:${toolArgs[0]}`}`] = Math.round((Date.now() - began) / 100) / 10;
  if (!json) return result.stdout;
  const line = result.stdout.trim().split("\n").filter((l) => l.startsWith("{")).pop();
  if (!line) fail(`${tool} printed no JSON line`);
  return JSON.parse(line);
}
const remember = (step) => {
  steps[step] = new Date().toISOString();
  writeFileSync(stepsPath, JSON.stringify(steps, null, 2) + "\n");
};
const stream = (command, ...rest) => run("build-stream.mjs", [command, briefId, "--codebase", codebase, ...rest]);

// ---- read ----
if (!existsSync(at("tree.json"))) {
  if (!options.page) fail("--page <url-substring> names the reference tab in the Proto window (the build has no read yet)");
  say("reading the page");
  stream("read", "--page", options.page, "--port", options.port);
} else say("read: tree.json exists, kept");

// ---- title ----
if (options.title && !steps.title) {
  stream("title", options.title);
  remember("title");
}

// ---- curate, and stop for the review unless told not to ----
const tree = JSON.parse(readFileSync(at("tree.json"), "utf8"));
const named = Boolean(tree.curation);
if (!existsSync(at("curation.json"))) {
  say("drafting the curation");
  stream("curate");
  if (!options["accept-curation"]) {
    const curation = JSON.parse(readFileSync(at("curation.json"), "utf8"));
    const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
    const list = (role) => curation.filter((entry) => entry.role === role).map((entry) => ({ id: entry.id, name: entry.name, marker: entry.marker, raw: nodes.get(entry.id)?.raw, text: nodes.get(entry.id)?.text ?? null }));
    console.log(JSON.stringify({ stop: "review-curation", curation: at("curation.json"), leaves: list("leaf"), sections: list("section"), next: "fix names that read as Group, Block, Text or part-nN where the raw and text say what the part is (the marker follows the name, kebab-case), then run this command again" }));
    process.exit(0);
  }
}

// ---- name ----
if (!named) {
  say("naming the tree");
  stream("name", at("curation.json"));
} else say("name: the tree is named, kept");

// ---- scaffold ----
say("scaffolding the workspace");
const workspace = run("scaffold.mjs", [options.slug, "--codebase", codebase, "--brief", briefId, ...(options.title ? ["--title", options.title] : [])], { json: true, sends: false });

// ---- replicate ----
const replicate = (retry = false) => run("replicate.mjs", [briefId, "--codebase", codebase, "--lanes", options.lanes, "--port", options.port, ...(retry && options["retry-mode"] === "failing" ? ["--retry-failing"] : []), ...(options["keep-dev"] ? ["--keep-dev"] : [])], { json: true });
let replicated;
const checkpointPath = at("copy-gate.json");
let checkpoint = !options.again && existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : null;
if (checkpoint) {
  say("replicate: resuming the saved copy-gate checkpoint");
  replicated = checkpoint.replicated;
} else if (existsSync(at("parts.json")) && !options.again) {
  say("replicate: parts.json exists, kept (--again redoes it)");
  replicated = JSON.parse(readFileSync(at("parts.json"), "utf8")).replicate;
} else {
  say("replicating the page");
  replicated = replicate();
  checkpoint = { replicated };
  writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2) + "\n");
  delete steps.gate;
  writeFileSync(stepsPath, JSON.stringify(steps, null, 2) + "\n");
}

// ---- the gate: a copy over it is tried once more, then the person is asked ----
const sink = options["no-send"] ? "file" : "site";
const gated = await (async () => {
  // A build continued after its gate was passed keeps that decision.
  if (steps.gate) return { outcome: steps.gate.outcome, replicated, answer: steps.gate.answer };
  const build = { codebase, briefId, runDir: buildDir, sink };
  return passGate({
    replicated,
    tree: JSON.parse(readFileSync(at("tree.json"), "utf8")),
    copy: async () => replicate(true),
    settle: () => settlePage(),
    ask: (fields, questionKey) => ask({ ...build, questionKey }, fields),
    wait: (questionId) => waitForAnswer(build, questionId),
    checkpoint,
    save: (state) => writeFileSync(checkpointPath, JSON.stringify(state, null, 2) + "\n"),
    say,
  });
})();
replicated = gated.replicated;
if (gated.outcome === "needs-input") {
  console.log(JSON.stringify({ ...gated.pending, checkpoint: checkpointPath, workspace, next: "Present this question in the current conversation, record the reply with build-stream answered, then run this command again without --again." }));
  process.exit(0);
}
steps.gate = { outcome: gated.outcome, ...(gated.answer ? { answer: gated.answer } : {}) };
remember("gateAt");

// ---- the parts list ----
const curated = JSON.parse(readFileSync(at("tree.json"), "utf8"));
const curation = curated.curation;
const nodes = new Map(curated.nodes.map((node) => [node.id, node]));
const roles = new Map(curation.map((entry) => [entry.id, entry]));
const sectionOf = (id) => {
  for (let node = nodes.get(nodes.get(id)?.parent); node; node = nodes.get(node.parent)) {
    const entry = roles.get(node.id);
    if (entry?.role === "section") return entry.marker;
  }
  return null;
};
const pascal = (slug) => slug.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
const fixes = new Map((replicated.toFix ?? []).map((entry) => [entry.id, entry]));
const failures = new Map((replicated.failed ?? []).map((entry) => [entry.id, entry]));
const parts = (replicated.parts ?? []).map((part) => {
  const entry = roles.get(part.id);
  const folder = `src/parts/${part.slug}`;
  return {
    id: part.id,
    name: entry?.name ?? part.slug,
    marker: part.marker,
    slug: part.slug,
    folder,
    component: `${folder}/${pascal(part.slug)}.tsx`,
    styles: `${folder}/${pascal(part.slug)}.module.css`,
    library: part.reused,
    status: part.status,
    rect: nodes.get(part.id)?.rect ?? null,
    section: sectionOf(part.id),
    differs: fixes.get(part.id)?.states ?? null,
    error: failures.get(part.id)?.error ?? null,
  };
});
const sections = curation
  .filter((entry) => entry.role === "section")
  .map((entry) => ({ id: entry.id, name: entry.name, marker: entry.marker, rect: nodes.get(entry.id)?.rect ?? null, section: sectionOf(entry.id) }));
const record = {
  briefId,
  codebase,
  title: workspace.title,
  workspace: { slug: workspace.slug, path: workspace.path, port: workspace.port, framework: workspace.framework, tailwind: workspace.tailwind },
  reference: { url: curated.url, viewport: curated.viewport },
  app: "src/App.tsx",
  manifest: "public/prototype.json",
  parts,
  sections,
  toFix: parts.filter((part) => part.status === "differs").map((part) => part.slug),
  failed: parts.filter((part) => part.status === "failed").map((part) => part.slug),
  page: replicated.page ?? null,
  gate: gateOf(gated, replicated),
  replicate: replicated,
};
writeFileSync(at("parts.json"), JSON.stringify(record, null, 2) + "\n");

// The site: the copy is done, the change comes next.
const reporter = createReporter({ codebase, briefId, runDir: buildDir, sink });
reporter.send([workflowEvent(buildDir, "build", `Building the change on top of the copy of ${workspace.title}`)]);
await reporter.flush();

const { replicate: _, ...printed } = record;
console.log(JSON.stringify({ ...printed, timings: { ...timings, total: Math.round((Date.now() - started) / 100) / 10 }, partsFile: at("parts.json") }));

// ---- helpers ----

/**
 * The reference page captured afresh once it has come to rest: the
 * frame every check compares against. The tree and the read are kept:
 * their node ids and names are the build's, already on the site.
 */
async function settlePage() {
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  const url = JSON.parse(readFileSync(at("tree.json"), "utf8")).url;
  const tab = await findPage(liveMatchOf(url), Number(options.port)).catch(() => null);
  if (!tab) fail(`the reference page (${liveMatchOf(url)}) is not open in the Proto window`);
  const page = await connect(tab.webSocketDebuggerUrl);
  try {
    await takeFrame(page, codebase);
  } finally {
    page.close();
  }
}

/**
 * What the gate decided, for the agent: proceed (the copy passed),
 * build (the person explicitly chose to start on this copy), or
 * reply (the person wrote what to do: `instruction`, followed as given).
 */
function gateOf(gate, result) {
  const out = { outcome: gate.outcome, line: result.gate?.line ?? null };
  if (gate.answer) out.answer = gate.answer;
  if (gate.outcome === "reply") out.instruction = gate.answer.text;
  return out;
}
