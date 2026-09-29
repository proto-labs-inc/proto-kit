#!/usr/bin/env node
/**
 * Run an import plan in one call: the palette, the type styles and the
 * inventory land at once, then every component is written from the
 * live page (tools/snapshot.mjs) and checked against it
 * (tools/check.mjs, each pass landing as it is made), several at a
 * time; a component that matches in every state lands as built, and
 * the library is published as they land (publishes coalesce, so this
 * never queues builds). What does not match stays "extracting" and is
 * listed for a unit to fix.
 *
 * Usage: node tools/import.mjs <codebase> <plan.json> [--lanes <n>]
 *
 * The plan is the orchestrator's decisions on top of tools/survey.mjs:
 *   {
 *     "palette": [{ name, value, group, role? }, …],        survey's palette, edited
 *     "type": [{ name?, family, size, weight, lineHeight, letterSpacing?, textTransform?, sample, tags? }, …],
 *     "components": [{
 *       "slug": "button", "name": "Button",
 *       "picture": "<png>",                                   survey's crop, optional
 *       "states": [{ "name": "Default", "selector": "…" },
 *                  { "name": "Primary", "selector": "…" },
 *                  { "name": "Hover", "selector": "…", "force": "hover" }, …]
 *     }, …]
 *   }
 * A type style without a name is named from where it is used.
 *
 * Prints one JSON line: { seconds, built: [slug], toFix: [{ slug, states }], failed: [{ slug, error }] }.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPage } from "./cdp/attach.mjs";
import { connect } from "./cdp/cdp.mjs";
import { takeFrame } from "./cdp/live.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const started = Date.now();
const options = { lanes: "8" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [codebase, planPath] = positional;
if (!codebase || !planPath) {
  console.error("usage: node tools/import.mjs <codebase> <plan.json> [--lanes <n>]");
  process.exit(1);
}
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const home = join(process.env.HOME ?? "", ".proto", codebase);
const scratch = join(home, "run", "import");
spawnSync("mkdir", ["-p", scratch]);

const tool = (name) => join(kit, "tools", name);
const step = (message) => console.error(`… ${message}`);

/** Run a kit tool to the end; resolves { status, stdout, stderr }. */
function run(name, toolArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool(name), ...toolArgs], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function write(subcommand, ...rest) {
  const result = spawnSync(process.execPath, [tool("library.mjs"), subcommand, codebase, ...rest], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`library.mjs ${subcommand}: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

// Publishing never waits here: a publish already running takes this one along.
function publish() {
  spawn(process.execPath, [tool("publish-library.mjs"), codebase], { stdio: "ignore", detached: true }).unref();
}

// ---- palette, type, inventory ----
if (plan.palette?.length) {
  write("tokens", JSON.stringify(plan.palette.map(({ name, value, group, role }) => (role ? { name, value, group, role } : { name, value, group }))));
}
if (plan.type?.length) write("types", JSON.stringify(nameTypes(plan.type)));
const components = plan.components ?? [];
if (components.length === 0) {
  console.error("the plan lists no components");
  process.exit(1);
}
write(
  "inventory",
  JSON.stringify(components.map(({ slug, name, picture }) => (picture ? { slug, name, screenshot: picture } : { slug, name }))),
);
publish();
step(`${plan.palette?.length ?? 0} colours, ${plan.type?.length ?? 0} type styles and ${components.length} components listed`);

// ---- the resting page, once: every resting state is cut from this frame ----
{
  const liveUrl = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source.liveUrl;
  const page = new URL(liveUrl);
  const tab = await findPage(`${page.host}${page.pathname}`);
  if (!tab) {
    console.error("the product page is not open in the Proto window");
    process.exit(1);
  }
  const live = await connect(tab.webSocketDebuggerUrl);
  const frame = await takeFrame(live, codebase);
  live.close();
  if (frame.hovered.length > 0) step("the pointer is over the product page in the Proto window; what it rests on is read live, not from the resting frame");
}

// ---- components, a few lanes at a time ----
const built = [];
const toFix = [];
const failed = [];
const queue = [...components];
async function lane() {
  for (let component = queue.shift(); component; component = queue.shift()) {
    const began = Date.now();
    const took = () => `${Math.round((Date.now() - began) / 1000)} s`;
    write("component", component.slug, "status", "extracting");
    const spec = join(scratch, `${component.slug}.json`);
    writeFileSync(spec, JSON.stringify({ slug: component.slug, name: component.name, states: component.states }));
    const snapped = await run("snapshot.mjs", [codebase, `@${spec}`]);
    const wrote = took();
    if (snapped.status !== 0) {
      failed.push({ slug: component.slug, error: snapped.stderr.trim().split("\n").pop() });
      step(`${component.slug}: could not be written (${snapped.stderr.trim().split("\n").pop()})`);
      continue;
    }
    const checked = await run("check.mjs", [codebase, component.slug]);
    let result = null;
    try {
      result = JSON.parse(checked.stdout);
    } catch {
      failed.push({ slug: component.slug, error: checked.stderr.trim().split("\n").pop() });
      continue;
    }
    if (result.matched) {
      write("component", component.slug, "status", "done");
      built.push(component.slug);
      publish();
      step(`${component.slug}: built, every state matches (written in ${wrote}, done in ${took()})`);
    } else {
      toFix.push({ slug: component.slug, states: result.states.filter((s) => !["match", "shifted", "offscreen"].includes(s.verdict)) });
      step(`${component.slug}: ${result.states.map((s) => `${s.state} ${s.verdict}`).join(", ")} (${took()})`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, Number(options.lanes)) }, lane));

console.log(JSON.stringify({ seconds: Math.round((Date.now() - started) / 1000), built, toFix, failed }));

/** Names for type styles the plan left unnamed, from the elements that use them. */
function nameTypes(styles) {
  const used = new Set();
  return styles.map((style) => {
    const { tags = [], uses, ...rest } = style;
    if (rest.name) {
      used.add(rest.name);
      return rest;
    }
    const size = parseFloat(rest.size);
    let base = `Body ${size}`;
    if (tags.some((t) => /^h[1-6]$/.test(t))) base = `Heading ${size}`;
    else if (/mono|code/i.test(rest.family)) base = `Mono ${size}`;
    else if (rest.textTransform === "uppercase") base = `Overline ${size}`;
    else if (tags.includes("label")) base = `Label ${size}`;
    else if (tags.includes("button")) base = `Button ${size}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base} (${rest.weight}${n > 2 ? ` ${n}` : ""})`;
    used.add(name);
    return { ...rest, name };
  });
}
