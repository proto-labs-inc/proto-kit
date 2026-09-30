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
 *                              [--accept-curation] [--again] [--keep-dev] [--lanes 12] [--no-send] [--port 9333]
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
 *
 * Then it sends `phase composing` and prints parts.json: one JSON
 * line with the workspace, every part (its node id, name, marker, the
 * files in src/parts/<slug>/, whether it came from the library, its
 * check's status, its rect on the page and the section it sits in),
 * every section, what is left to fix, and the page's own verdict.
 * --keep-dev leaves the workspace's dev server up for the checks that
 * follow; without it the serve skill's run starts it again.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFolder } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const tools = join(kit, "tools");
const started = Date.now();
const USAGE = 'usage: node tools/proto-build.mjs <briefId> --codebase <id> --page <url-substring> --slug <slug> --title "<title>" [--accept-curation] [--again] [--keep-dev] [--lanes 12] [--no-send]';

const options = { lanes: "12", port: "9333" };
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
const codebase = options.codebase;
const buildDir = buildFolder(codebase, briefId);
const at = (name) => join(buildDir, name);
const stepsPath = at("steps.json");
const steps = existsSync(stepsPath) ? JSON.parse(readFileSync(stepsPath, "utf8")) : {};
const timings = {};
const say = (line) => console.error(`proto-build: ${line}`);

/** One kit tool as its own process: its progress goes to stderr, its JSON line comes back. */
function run(tool, toolArgs, { json = false } = {}) {
  const began = Date.now();
  const noSend = options["no-send"] ? ["--no-send"] : [];
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
const workspace = run("scaffold.mjs", [options.slug, "--codebase", codebase, "--brief", briefId, ...(options.title ? ["--title", options.title] : [])], { json: true });

// ---- replicate ----
let replicated;
if (existsSync(at("parts.json")) && !options.again) {
  say("replicate: parts.json exists, kept (--again redoes it)");
  replicated = JSON.parse(readFileSync(at("parts.json"), "utf8")).replicate;
} else {
  say("replicating the page");
  replicated = run("replicate.mjs", [briefId, "--codebase", codebase, "--lanes", options.lanes, "--port", options.port, ...(options["keep-dev"] ? ["--keep-dev"] : [])], { json: true });
}

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
  replicate: replicated,
};
writeFileSync(at("parts.json"), JSON.stringify(record, null, 2) + "\n");

// The site: the copy is done, the change comes next.
const reporter = createReporter({ codebase, briefId, runDir: buildDir, sink: options["no-send"] ? "file" : "site" });
reporter.send([{ kind: "phase", phase: "composing", line: `Building the change on top of the copy of ${workspace.title}` }]);
await reporter.flush();

const { replicate: _, ...printed } = record;
console.log(JSON.stringify({ ...printed, timings: { ...timings, total: Math.round((Date.now() - started) / 100) / 10 }, partsFile: at("parts.json") }));
