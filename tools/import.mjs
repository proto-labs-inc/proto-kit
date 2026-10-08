#!/usr/bin/env node
/**
 * Run one sequential import stage per call. Foundations writes the palette,
 * type styles and inventory only. Core and extended components are written from the
 * live page (tools/snapshot.mjs) and checked against it
 * (tools/check.mjs, each pass landing as it is made), several at a
 * time; a component that matches in every state lands as built, and
 * the library is published as they land (publishes coalesce, so this
 * never queues builds). What does not match, or could not be written,
 * lands as skipped with the product's picture and where it differs,
 * so intermediate progress can be published; it is listed for a unit to fix,
 * and lands as built when the unit's check passes.
 *
 * Usage: node tools/import.mjs <codebase> [<plan.json>] [--stage <foundations|core|extended>] [--theme <light|dark>] [--lanes <n>]
 *        node tools/import.mjs <codebase> --stage <core|extended> --check-theme <light|dark> [--lanes <n>]
 *   The plan defaults to ~/.proto/<codebase>/run/plan.json (tools/plan.mjs).
 *
 * The plan is the orchestrator's decisions on top of tools/survey.mjs:
 *   {
 *     "themes": { "light": [{ name, value, group, role? }, …],
 *                 "dark":  [{ name, value, group, role? }, …] },
 *     "type": [{ name?, family, size, weight, lineHeight, letterSpacing?, textTransform?, sample, tags? }, …],
 *     "components": [{
 *       "slug": "button", "name": "Button", "stage": "core",
 *       "picture": "<png>",                                   survey's crop, optional
 *       "states": [{ "name": "Default", "selector": "…" },
 *                  { "name": "Primary", "selector": "…" },
 *                  { "name": "Hover", "selector": "…", "force": "hover" }, …]
 *     }, …]
 *   }
 * A type style without a name is named from where it is used.
 *
 * A stage checkpoint requires current checks in both themes for built components, or a recorded skip, before the next
 * stage can start. Failures remain in this stage for repair. finish-import
 * owns final completion and publication after all three checkpoints pass.
 *
 * Prints one JSON line: { seconds, built: [slug], toFix: [{ slug, states, unfitted, reason }], failed: [{ slug, error }], gate: { line, status: "awaiting-verification" } }.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findPage } from "./cdp/attach.mjs";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { frameCrop, takeFrame, withLive } from "./cdp/live.mjs";
import { classifyState, record, tailFile } from "./tail.mjs";

import { componentStage, requirePreviousStages, STAGES } from "./import-stages.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const started = Date.now();
const options = { lanes: "12", theme: "light", stage: "foundations" };
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [codebase, planArg] = positional;
if (!codebase) {
  console.error("usage: node tools/import.mjs <codebase> [<plan.json>] [--stage <foundations|core|extended>] [--theme <light|dark>] [--lanes <n>]");
  process.exit(1);
}
if (!["light", "dark"].includes(options.theme)) {
  console.error("--theme is light or dark");
  process.exit(1);
}
if (!STAGES.includes(options.stage)) throw new Error("--stage is foundations, core or extended");
const home = join(process.env.HOME ?? "", ".proto", codebase);
// The plan tools/plan.mjs wrote, unless another is named.
const plan = options["check-theme"] ? null : JSON.parse(readFileSync(planArg ?? join(home, "run", "plan.json"), "utf8"));
const scratch = join(home, "run", "import");
spawnSync("mkdir", ["-p", scratch]);

const tool = (name) => join(kit, "tools", name);
const step = (message) => console.error(`… ${message}`);
// A tool's failure in one line: the error it named, not Node's own banner under it.
const lastLine = (stderr) => {
  const lines = stderr.trim().split("\n").filter((line) => line.trim() !== "" && !/^Node\.js v/.test(line));
  return lines.find((line) => /Error|error:|could not|does not|did not|no open tab|nothing on/.test(line))?.trim() ?? lines.pop()?.trim() ?? "failed";
};

/**
 * Run a kit tool to the end, or stop it after two minutes: one stuck
 * component never holds up the import behind it (it is listed as
 * failed). Resolves { status, stdout, stderr }.
 */
function run(name, toolArgs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool(name), ...toolArgs], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const limit = setTimeout(() => {
      stderr += `\n${name} did not finish within 2 minutes and was stopped`;
      child.kill("SIGKILL");
    }, 120_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      clearTimeout(limit);
      resolve({ status, stdout, stderr });
    });
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

if (options["check-theme"]) {
  const theme = options["check-theme"];
  if (!["light", "dark"].includes(theme)) throw new Error("--check-theme is light or dark");
  const manifest = JSON.parse(readFileSync(join(home, "library", "public", "manifest.json"), "utf8"));
  requirePreviousStages(join(home, "library"), manifest, options.stage);
  if (options.stage === "foundations") throw new Error("Foundations need surveys, not component checks. Select --stage core or extended.");
  const queue = (manifest.components ?? []).filter((component) => component.module && componentStage(component) === options.stage).map((component) => component.slug);
  const matched = [];
  const toFix = [];
  const failed = [];
  async function checkLane() {
    for (let slug = queue.shift(); slug; slug = queue.shift()) {
      const checked = await run("check.mjs", [codebase, slug, "--theme", theme]);
      try {
        const result = JSON.parse(checked.stdout);
        if (result.matched) matched.push(slug);
        else {
          toFix.push({ slug, states: result.states.filter((state) => !["match", "shifted", "context", "faint", "offscreen"].includes(state.verdict)) });
          await leave(manifest.components.find((c) => c.slug === slug), "did-not-match", `The ${theme} appearance still differs from the product`);
        }
      } catch {
        failed.push({ slug, error: checked.stderr.trim().split("\n").pop() });
        await leave(manifest.components.find((c) => c.slug === slug), "could-not-isolate", `The import could not check its ${theme} appearance this run`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Number(options.lanes)) }, checkLane));
  console.log(JSON.stringify({ theme, matched, toFix, failed }));
  process.exit(0);
}

// Foundations are a separate invocation. Later stages never rewrite palettes
// or type styles, which would invalidate earlier component checks.
const components = (plan.components ?? []).map((c) => ({ ...c, stage: componentStage(c) }));
if (options.stage === "foundations") {
  write("stages");
  const themes = plan.themes ?? (plan.palette?.length ? { [options.theme]: plan.palette } : {});
  for (const theme of ["light", "dark"]) {
    const palette = themes[theme];
    if (palette?.length) write("tokens", theme, JSON.stringify(palette.map(({ name, value, group, role }) => ({ name, value, group, ...(role ? { role } : {}) }))));
  }
  if (plan.type?.length) write("types", JSON.stringify(nameTypes(plan.type)));
  if (components.length) write("inventory", JSON.stringify(components.map(({ slug, name, picture, stage }) => ({ slug, name, stage, ...(picture ? { screenshot: picture } : {}) }))));
  publish();
  console.log(JSON.stringify({ stage: "foundations", gate: { status: "awaiting-verification", line: "Foundations captured. Apply both current theme surveys, then run library.mjs stage <codebase> foundations complete. No components have started." } }));
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(join(home, "library", "public", "manifest.json"), "utf8"));
requirePreviousStages(join(home, "library"), manifest, options.stage);
// The full inventory is fixed at the foundations stage. A partial resume plan
// cannot silently omit unverified components or reclassify them to bypass a gate.
const selected = components.filter((c) => c.stage === options.stage);
for (const component of selected) {
  const recorded = manifest.components.find((c) => c.slug === component.slug);
  if (!recorded || componentStage(recorded) !== component.stage) throw new Error(`${component.slug}: update the foundations inventory before changing component stages.`);
}
if (!selected.length) {
  console.log(JSON.stringify({ stage: options.stage, gate: { status: "awaiting-verification", line: "No components in this plan for this stage. Complete the stage checkpoint against the full inventory." } }));
  process.exit(0);
}

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
// Each component's states' pixels, for the tail's weights.
const areas = new Map();
// The heaviest first (most states to read and check), so a big
// component starts in the first batch instead of becoming the tail; the
// library still lists them in the plan's order.
const queue = [...selected].sort((a, b) => b.states.length - a.states.length);
async function lane() {
  for (let component = queue.shift(); component; component = queue.shift()) {
    const began = Date.now();
    const took = () => `${Math.round((Date.now() - began) / 1000)} s`;
    write("component", component.slug, "status", "extracting");
    const spec = join(scratch, `${component.slug}.json`);
    writeFileSync(spec, JSON.stringify({ slug: component.slug, name: component.name, states: component.states }));
    const snapped = await run("snapshot.mjs", [codebase, `@${spec}`, "--theme", options.theme]);
    const wrote = took();
    if (snapped.status !== 0) {
      const error = lastLine(snapped.stderr);
      failed.push({ slug: component.slug, error });
      await leave(component, "could-not-isolate", "The import could not read it from the page on its own this run");
      step(`${component.slug}: could not be written (${error})`);
      continue;
    }
    let unfitted = [];
    try {
      unfitted = JSON.parse(snapped.stdout).unfitted ?? [];
    } catch {
      // The writer's line is for the record; a component it wrote is checked either way.
    }
    if (unfitted.length > 0) step(`${component.slug}: sizes could not be fitted for ${unfitted.join(", ")} (the render route did not answer); checking as written`);
    const checked = await run("check.mjs", [codebase, component.slug, "--theme", options.theme]);
    let result = null;
    try {
      result = JSON.parse(checked.stdout);
    } catch {
      const error = lastLine(checked.stderr);
      failed.push({ slug: component.slug, error });
      await leave(component, "could-not-isolate", "The import could not check it against the page this run");
      step(`${component.slug}: could not be checked (${error})`);
      continue;
    }
    areas.set(component.slug, result.states.map((s) => s.area ?? 1));
    if (result.matched) {
      write("component", component.slug, "status", "done");
      built.push(component.slug);
      publish();
      step(`${component.slug}: built, every state matches (written in ${wrote}, done in ${took()})`);
    } else {
      const differing = result.states.filter((s) => !["match", "shifted", "context", "faint", "offscreen"].includes(s.verdict));
      toFix.push({ slug: component.slug, states: differing, unfitted });
      await leave(component, "did-not-match", whereItDiffers(component, differing));
      step(`${component.slug}: ${result.states.map((s) => `${s.state} ${s.verdict}`).join(", ")} (${took()})`);
    }
  }
}

/**
 * A component the import could not finish stays in the library with
 * the product's picture and why, as skipped, so the library progresses
 * without waiting on the unit that fixes it; the unit lands it as done
 * when its check passes. The picture is the survey's crop, else the
 * product capture of its latest check.
 */
async function leave(component, kind, reason) {
  const picture = component.picture ?? latestCapture(component.slug) ?? (await cropFromFrame(component));
  try {
    write("component", component.slug, "status", "skipped", "--kind", kind, "--reason", reason, ...(picture ? ["--screenshot", picture] : []));
    publish();
  } catch (error) {
    step(`${component.slug}: could not be left as skipped (${error.message.split("\n").pop()})`);
  }
}

// The component's default state cut from the resting frame, when the page still stands where the frame was taken.
async function cropFromFrame(component) {
  const selector = component.states?.[0]?.selector;
  if (!selector) return null;
  try {
    const liveUrl = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8")).source.liveUrl;
    const page = new URL(liveUrl);
    const tab = await findPage(`${page.host}${page.pathname}`);
    if (!tab) return null;
    const live = await connect(tab.webSocketDebuggerUrl);
    try {
      const rect = await withLive(() => evaluate(live, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`));
      if (!rect || rect.width === 0 || rect.height === 0) return null;
      const out = join(scratch, `${component.slug}-crop.png`);
      return (await frameCrop(live, codebase, rect, out)) ? out : null;
    } finally {
      live.close();
    }
  } catch {
    return null;
  }
}

// The product capture of the component's latest landed check, from the library's own history.
function latestCapture(slug) {
  try {
    const manifest = JSON.parse(readFileSync(join(home, "library", "public", "manifest.json"), "utf8"));
    const entry = manifest.components.find((c) => c.slug === slug);
    const live = [...(entry?.history ?? [])].reverse().find((pass) => pass.live)?.live;
    return live ? join(home, "library", "public", live) : null;
  } catch {
    return null;
  }
}

// Where the component differs, for the person whose product it is: the states and the spot, in one sentence under the reason cap.
function whereItDiffers(component, states) {
  const spots = states.map((s) => `${s.state.toLowerCase()} ${s.activity?.replace(/^[^:]*:\s*/, "").toLowerCase() ?? "differs"}`);
  let sentence = `Not identical to the product yet: ${spots.join("; ")}`;
  if (sentence.length > 120) sentence = `Not identical to the product yet in ${states.length} of its states (${states.map((s) => s.state.toLowerCase()).join(", ")})`;
  if (sentence.length > 120) sentence = `Not identical to the product yet in ${states.length} of its states`;
  return sentence;
}
await Promise.all(Array.from({ length: Math.max(1, Number(options.lanes)) }, lane));

// ---- this stage awaits both-theme verification and its checkpoint ----
publish();
// The tail's own record: every component with its weight (its largest
// state's pixels), the built ones matched already.
const weightOf = (slug) => Math.max(1, ...(areas.get(slug) ?? [1]));
record(tailFile(codebase), {
  kind: "phase",
  phase: "import-tail",
  items: [...built.map((slug) => ({ item: slug, weight: weightOf(slug), matched: true })), ...toFix.map((t) => ({ item: t.slug, weight: weightOf(t.slug) })), ...failed.map((f) => ({ item: f.slug, weight: weightOf(f.slug) }))],
});
for (const entry of toFix) {
  // Rule 1 names every one of them; rule 2 says when a unit need not even try.
  const small = entry.states.length > 0 && entry.states.every((s) => classifyState({ verdict: s.verdict, mismatch: s.mismatch, area: s.area }).tail);
  const why = small ? classifyState({ verdict: entry.states[0].verdict, mismatch: entry.states[0].mismatch, area: entry.states[0].area }).reason : `${entry.states.map((s) => s.state).join(", ")} still differ${entry.states.length === 1 ? "s" : ""} at the gate`;
  entry.reason = why;
  entry.rule = small ? "small" : "gate";
  record(tailFile(codebase), { kind: "item", item: entry.slug, rule: entry.rule, reason: why });
  step(`${entry.slug} left for later: ${why}`);
}
for (const entry of failed) {
  entry.rule = "gate";
  record(tailFile(codebase), { kind: "item", item: entry.slug, rule: "gate", reason: entry.error });
  step(`${entry.slug} left for later: ${entry.error}`);
}
const left = toFix.length + failed.length;
let line = `${options.stage}: ${built.length} of ${selected.length} built in ${Math.round((Date.now() - started) / 1000)} s`;
line += "; verify both themes and complete this stage before starting the next";
if (left > 0) line += `. ${left} left for later, each with its reason above; failed or skipped components remain visible and do not block the next stage.`;
step(line);

console.log(JSON.stringify({ stage: options.stage, seconds: Math.round((Date.now() - started) / 1000), built, toFix, failed, gate: { line, status: "awaiting-verification" } }));

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
