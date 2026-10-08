#!/usr/bin/env node
/**
 * The one writer of the library contract (docs/library-contract.md).
 * Every subcommand is one short line for the import to run: it reads
 * public/manifest.json, applies one change, writes the manifest back
 * atomically (temp file, then rename) and appends one line to
 * public/events.jsonl, all under a lock, so parallel lanes never
 * interleave a write. Nothing else in the kit writes these files; the
 * fake driver (tools/fake-import/run.mjs) goes through here too.
 *
 * <library> is the library app's folder (~/.proto/<codebase>/library)
 * or just the codebase id, which resolves to that folder. <json> is a
 * JSON literal or @path to a file holding one.
 *
 *   init <library> <codebase> <source> --page-url <url> --page-title "<title>" [--product-name "<name>"] [--favicon <file>]
 *       A fresh run when no run is open (resets everything), a resume
 *       when one is; prints which. Appends "Reading the source". The
 *       product's name comes from --product-name, else from the page
 *       title ("Expenses · Meridian" names Meridian), else from the
 *       codebase's display name in codebase.json, never from its id.
 *       --favicon is the page's icon as a file; it is copied to
 *       public/product/favicon.<ext> and named in the manifest, so the
 *       app can show the page the way a browser tab does.
 *   token <library> <light|dark> <json>  one { name, value, group, role? }
 *   tokens <library> <light|dark> <json> replace one palette at once, [{ name, value, group, role? }, …]
 *   type <library> <json>             one { name, family, size, weight, lineHeight, sample }
 *   types <library> <json>            many at once: one write, one line
 *   inventory <library> <json>        every component at once, [{ slug, name, screenshot? }], all "found";
 *                                     screenshot is the product's own crop of it (tools/cdp/crop.mjs),
 *                                     copied to components/<slug>/screenshot.png so the library shows
 *                                     the component before it is built
 *   component <library> <slug> status <found|extracting|done|skipped|queued>
 *       [--kind <could-not-isolate|did-not-match|not-tried>] [--reason "<sentence>"] [--screenshot <png>] [--activity "<line>"]
 *       done reads the component the unit authored in
 *       src/components/<slug>/ (one <Slug>.tsx with a default export,
 *       its <Slug>.module.css, and component.json holding every state
 *       the product shows as a prop set, the first being the default,
 *       and the names of the manifest tokens the component uses) and
 *       records its module path, states and tokens; a token the
 *       manifest does not hold is refused. skipped needs the kind and the reason (one plain sentence of at most 140
 *       characters in the product's terms), plus the product crop when available
 *       (copied to components/<slug>/screenshot.png). The crop stays
 *       on the entry from then on; the kind and reason stay while
 *       queued and go when the component is read again.
 *   history <library> <slug> --theme <light|dark> --screenshot <png> --diff <png> [--live <png>] [--verdict <v>] --mismatch <n> --activity "<line>"
 *       Moves the images into components/<slug>/history/ and appends
 *       the pass. Every pass a component made is kept. tools/check.mjs
 *       lands each pass the moment it is made, so a component's checks
 *       stream into the library while it is still being read.
 *   event <library> [slug] <activity>  one activity line, about a component or the whole import
 *   take-queued <library>             pops queue.json: prints the slug it took (now "queued",
 *                                     completedAt cleared), "*" for a request to import
 *                                     everything again (the manifest is untouched; run init),
 *                                     or nothing
 *   complete <library>                sets completedAt; refuses while a component is still moving
 */
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { completionProblems, paletteDigest, checkFingerprint } from "./import-evidence.mjs";

import { componentStage, completeStage, refreshStages, requirePreviousStages, requireAllStages, STAGES } from "./import-stages.mjs";

const USAGE = `usage: node library.mjs <subcommand> <library> ...
  init <library> <codebase> <source> --page-url <url> --page-title <title> [--product-name <name>] [--favicon <file>]
  token <library> <light|dark> <json>
  tokens <library> <light|dark> <json array>
  type <library> <json>
  types <library> <json array>
  inventory <library> <json array>
  component <library> <slug> status <found|extracting|done|skipped|queued> [--kind ...] [--reason ...] [--screenshot ...] [--activity ...]
  history <library> <slug> --theme <light|dark> --screenshot <png> --diff <png> [--live <png>] [--verdict <v>] --mismatch <n> --activity <line>
  event <library> [slug] <activity>
  take-queued <library>
  survey <library> <light|dark> <capture JSON>
  checks <library> <slug> <light|dark> <results JSON>
  stages <library>
  stage <library> <foundations|core|extended> complete
  complete <library>`;
const STATUSES = ["found", "extracting", "done", "skipped", "queued"];
// Why a component was skipped, as the app groups them: it could not be
// lifted out of the page on its own, it was rebuilt but never matched
// the product closely enough, or the import never got to it.
const SKIP_KINDS = ["could-not-isolate", "did-not-match", "not-tried"];
const REASON_CAP = 140;
// What a check found (tools/verify-replica.mjs).
const VERDICTS = ["match", "shifted", "context", "faint", "offscreen", "differs"];
const THEMES = ["light", "dark"];
// The whole import, asked for again from the app: a request whose slug
// is this, rather than a component's.
const EVERYTHING = "*";

// Thrown, not exited: a failure inside the lock must still release
// it, so the lock's finally runs before the process ends.
class Failure extends Error {}
const fail = (message) => {
  throw new Failure(message);
};
process.on("uncaughtException", (e) => {
  if (!(e instanceof Failure)) throw e;
  console.error(e.message);
  process.exit(1);
});

// ---- arguments ----

const [subcommand, libraryArg, ...rest] = process.argv.slice(2);
if (!subcommand || !libraryArg) fail(USAGE);

const options = {};
const positional = [];
for (let i = 0; i < rest.length; i += 1) {
  const arg = rest[i];
  if (arg.startsWith("--")) {
    if (rest[i + 1] === undefined) fail(`${arg} needs a value\n${USAGE}`);
    options[arg.slice(2)] = rest[i + 1];
    i += 1;
  } else {
    positional.push(arg);
  }
}

const libraryDir = resolveLibrary(libraryArg);
const publicDir = join(libraryDir, "public");
if (!existsSync(join(libraryDir, "package.json")) || !existsSync(publicDir)) {
  fail(`${libraryDir} is not a library app (no package.json or public/); scaffold it first (tools/host-library.mjs)`);
}

function resolveLibrary(arg) {
  if (!arg.includes("/")) {
    const byId = join(process.env.HOME ?? "", ".proto", arg, "library");
    if (existsSync(byId)) return byId;
  }
  return resolve(arg);
}

function readJsonArg(arg) {
  if (arg === undefined) fail(`missing JSON argument\n${USAGE}`);
  let text = arg;
  if (arg.startsWith("@")) text = readFileSync(arg.slice(1), "utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    fail(`not JSON: ${e.message}`);
  }
}

// ---- the files ----

const paths = {
  manifest: join(publicDir, "manifest.json"),
  events: join(publicDir, "events.jsonl"),
  queue: join(publicDir, "queue.json"),
  components: join(publicDir, "components"),
  product: join(publicDir, "product"),
  modules: join(libraryDir, "src", "components"),
  lock: join(publicDir, ".lock"),
};
const now = () => new Date().toISOString();

const EMPTY = { verification: null, importStages: null, codebase: null, source: null, product: null, startedAt: null, completedAt: null, themes: { light: [], dark: [] }, type: [], components: [] };

function readManifest() {
  try {
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    if (!manifest.themes) {
      const tokens = Array.isArray(manifest.tokens) ? manifest.tokens : [];
      manifest.themes = { light: tokens, dark: tokens };
      delete manifest.tokens;
      for (const component of manifest.components ?? []) {
        if (Array.isArray(component.tokens)) component.tokens = { light: component.tokens, dark: component.tokens };
        for (const pass of component.history ?? []) pass.theme ??= "light";
      }
    }
    return manifest;
  } catch {
    return { ...EMPTY };
  }
}

// Temp file then rename: a reader (Vite's middleware, the app) never
// sees a half-written manifest.
function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

// One appended line is one write call, which O_APPEND keeps whole.
function appendEvent(activity, slug) {
  const line = { at: now() };
  if (slug !== undefined) line.component = slug;
  line.activity = activity;
  appendFileSync(paths.events, JSON.stringify(line) + "\n");
  if (slug === undefined) console.log(`· ${activity}`);
  else console.log(`· [${slug}] ${activity}`);
}

// mkdir is atomic on every filesystem the kit runs on: whoever makes
// the lock folder holds it. A lock older than ten seconds belongs to
// a writer that died mid-call and is taken over.
function withLock(work) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(paths.lock);
      break;
    } catch {
      let age = 0;
      try {
        age = Date.now() - statSync(paths.lock).mtimeMs;
      } catch {}
      if (age > 10_000) {
        rmSync(paths.lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) fail(`${paths.lock} is held by another writer; remove it if nothing is running`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return work();
  } finally {
    rmSync(paths.lock, { recursive: true, force: true });
  }
}

// Every subcommand: read, change, write, event, under the lock.
function change(work) {
  return withLock(() => {
    const manifest = readManifest();
    const result = work(manifest);
    if (["token", "tokens", "type", "types", "inventory", "component"].includes(subcommand)) manifest.completedAt = null;
    refreshStages(libraryDir, manifest);
    writeJsonAtomic(paths.manifest, manifest);
    if (result?.activity !== undefined) appendEvent(result.activity, result.slug);
    return result;
  });
}

const componentIn = (manifest, slug) => {
  const entry = manifest.components.find((c) => c.slug === slug);
  if (!entry) fail(`no component "${slug}" in the manifest; it has: ${manifest.components.map((c) => c.slug).join(", ") || "none"}`);
  return entry;
};
const folderOf = (slug) => join(paths.components, slug);
const relative = (slug, ...parts) => ["components", slug, ...parts].join("/");

// One plain sentence for the user, in the product's terms: a paragraph
// or an agent's voice ("could not be pixel-verified") is refused.
function requireReason(reason) {
  if (!reason) fail("skipped needs --reason, one plain sentence for the user");
  if (reason.length > REASON_CAP) fail(`--reason is ${reason.length} characters; the cap is ${REASON_CAP}: one plain sentence in the product's terms, no agent voice`);
  if (/\n/.test(reason)) fail("--reason is one sentence on one line");
  if (/verif|pixel|extract|cdp|replica|measur/i.test(reason)) fail("--reason is written for the user in the product's terms, not in the import's (no verifying, pixels, extracting, replicas)");
}

// The product's name: given, else the last part of the page title
// ("Expenses · Meridian", "Meridian | Expenses" both name Meridian),
// else the codebase's display name in codebase.json, never its id.
function productName(codebase, pageTitle, given) {
  if (given) return given;
  const parts = pageTitle.split(/\s+[·|]\s+|\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) return parts[parts.length - 1];
  if (parts.length === 1) return parts[0];
  try {
    const record = JSON.parse(readFileSync(join(libraryDir, "..", "codebase.json"), "utf8"));
    if (typeof record.name === "string" && record.name.trim() !== "" && record.name !== codebase) return record.name;
  } catch {}
  fail("the page has no title and codebase.json names no display name; pass --product-name");
}

// The page's icon, kept beside the manifest as product/favicon.<ext>
// (the file's own extension, lower-cased) so a PNG, an ICO and an SVG
// each keep their type; the manifest names it relative to public/.
function placeFavicon(file) {
  if (!existsSync(file) || !statSync(file).isFile()) fail(`--favicon ${file} is not a file`);
  const ext = (file.match(/\.([a-z0-9]+)$/i)?.[1] ?? "png").toLowerCase();
  const name = `favicon.${ext}`;
  mkdirSync(paths.product, { recursive: true });
  copyFileSync(file, join(paths.product, name));
  return `product/${name}`;
}

function requireString(value, what) {
  if (typeof value !== "string" || value.trim() === "") fail(`${what} must be a non-empty string`);
  return value;
}

// ---- subcommands ----

const commands = {
  init() {
    const [codebase, source] = positional;
    if (!codebase || !source || !options["page-url"] || options["page-title"] === undefined) fail(USAGE);
    const product = {
      name: productName(codebase, options["page-title"], options["product-name"]),
      pageUrl: options["page-url"],
      pageTitle: options["page-title"],
    };
    if (options.favicon !== undefined) product.favicon = placeFavicon(options.favicon);
    mkdirSync(paths.components, { recursive: true });
    const outcome = change((manifest) => {
      const open = manifest.startedAt !== null && manifest.completedAt === null;
      if (open) {
        Object.assign(manifest, { codebase, source, product });
        return { kind: "resumed", activity: "Resuming the import" };
      }
      rmSync(paths.components, { recursive: true, force: true });
      mkdirSync(paths.components, { recursive: true });
      // A fresh run keeps only the icon it was given; an earlier run's goes.
      if (existsSync(paths.product)) {
        for (const name of readdirSync(paths.product)) {
          if (product.favicon !== `product/${name}`) rmSync(join(paths.product, name), { force: true });
        }
      }
      for (const slug of importedModules()) rmSync(join(paths.modules, slug), { recursive: true, force: true });
      writeFileSync(paths.events, "");
      writeJsonAtomic(paths.queue, { requests: [] });
      Object.assign(manifest, { ...EMPTY, themes: { light: [], dark: [] }, codebase, source, product, startedAt: now(), type: [], components: [] });
      return { kind: "fresh", activity: "Reading the source" };
    });
    console.log(`${outcome.kind}: ${libraryDir}`);
  },

  token() {
    const [theme, json] = positional;
    if (!THEMES.includes(theme)) fail("token needs light or dark before its JSON");
    const token = readJsonArg(json);
    checkToken(token);
    change((manifest) => {
      putByName(manifest.themes[theme], token);
      return { activity: `Reading ${theme} colours (${token.name})` };
    });
  },

  tokens() {
    const [theme, json] = positional;
    if (!THEMES.includes(theme)) fail("tokens needs light or dark before its JSON");
    const list = readJsonArg(json);
    if (!Array.isArray(list) || list.length === 0) fail("tokens takes a non-empty JSON array of { name, value, group, role? }");
    list.forEach(checkToken);
    change((manifest) => {
      manifest.themes[theme] = [];
      for (const token of list) putByName(manifest.themes[theme], token);
      return { activity: `Reading ${theme} colours (${list.length} of them)` };
    });
  },

  type() {
    const style = readJsonArg(positional[0]);
    checkType(style);
    change((manifest) => {
      putByName(manifest.type, style);
      return { activity: `Reading type styles (${style.name})` };
    });
  },

  types() {
    const list = readJsonArg(positional[0]);
    if (!Array.isArray(list) || list.length === 0) fail("types takes a non-empty JSON array of { name, family, size, weight, lineHeight, sample }");
    list.forEach(checkType);
    change((manifest) => {
      for (const style of list) putByName(manifest.type, style);
      return { activity: `Reading type styles (${list.length} of them)` };
    });
  },

  inventory() {
    const list = readJsonArg(positional[0]);
    if (!Array.isArray(list) || list.length === 0) fail("inventory takes a non-empty JSON array of { slug, name }");
    for (const item of list) {
      requireString(item.slug, "slug");
      requireString(item.name, "name");
      componentStage(item);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(item.slug)) fail(`slug "${item.slug}" must be lowercase letters, digits and dashes`);
      if (item.screenshot !== undefined && !existsSync(item.screenshot)) fail(`${item.screenshot} does not exist`);
    }
    change((manifest) => {
      for (const item of list) {
        const existing = manifest.components.find((c) => c.slug === item.slug);
        if (existing) { existing.stage = componentStage(item); continue; }
        const entry = { slug: item.slug, name: item.name, stage: componentStage(item), status: "found", states: [], tokens: { light: [], dark: [] }, history: [] };
        mkdirSync(folderOf(item.slug), { recursive: true });
        if (item.screenshot !== undefined) {
          copyFileSync(item.screenshot, join(folderOf(item.slug), "screenshot.png"));
          entry.screenshot = relative(item.slug, "screenshot.png");
        }
        manifest.components.push(entry);
      }
      return { activity: `Found ${manifest.components.length} components` };
    });
  },

  component() {
    const [slug, keyword, status] = positional;
    if (!slug || keyword !== "status" || !STATUSES.includes(status)) fail(USAGE);
    if (status === "skipped") {
      if (!SKIP_KINDS.includes(options.kind)) fail(`skipped needs --kind, one of ${SKIP_KINDS.join(", ")}`);
      requireReason(options.reason);
    }
    change((manifest) => {
      const entry = componentIn(manifest, slug);
      if (manifest.importStages && ["extracting", "done"].includes(status)) {
        try { requirePreviousStages(libraryDir, manifest, componentStage(entry)); } catch (error) { fail(error.message); }
      }
      const folder = folderOf(slug);
      mkdirSync(folder, { recursive: true });
      entry.status = status;
      switch (status) {
        case "skipped":
          if (options.screenshot) {
            if (!existsSync(options.screenshot)) fail(`${options.screenshot} does not exist`);
            copyFileSync(options.screenshot, join(folder, "screenshot.png"));
            entry.screenshot = relative(slug, "screenshot.png");
          }
          entry.skipKind = options.kind;
          entry.reason = options.reason;
          unbuild(entry);
          break;
        case "queued":
          unbuild(entry);
          manifest.completedAt = null;
          break;
        case "found":
        case "extracting":
          unbuild(entry);
          forget(entry);
          break;
        case "done":
          forget(entry);
          Object.assign(entry, authored(slug, manifest.themes));
          break;
      }
      return { activity: options.activity ?? statusActivity(status, entry.name), slug };
    });
  },

  history() {
    const [slug] = positional;
    const mismatch = Number(options.mismatch);
    if (!slug || !THEMES.includes(options.theme) || !options.screenshot || !options.diff || !options.activity || !Number.isInteger(mismatch) || mismatch < 0) fail(USAGE);
    for (const image of [options.screenshot, options.diff, options.live].filter(Boolean)) if (!existsSync(image)) fail(`${image} does not exist`);
    if (options.verdict !== undefined && !VERDICTS.includes(options.verdict)) fail(`--verdict is one of ${VERDICTS.join(", ")}`);
    change((manifest) => {
      const entry = componentIn(manifest, slug);
      const folder = join(folderOf(slug), "history");
      mkdirSync(folder, { recursive: true });
      const n = nextPass(folder);
      renameOrCopy(options.screenshot, join(folder, `${n}.png`));
      renameOrCopy(options.diff, join(folder, `${n}-diff.png`));
      const pass = {
        at: now(),
        activity: options.activity,
        screenshot: relative(slug, "history", `${n}.png`),
        diff: relative(slug, "history", `${n}-diff.png`),
        mismatch,
        theme: options.theme,
      };
      if (options.live) {
        renameOrCopy(options.live, join(folder, `${n}-live.png`));
        pass.live = relative(slug, "history", `${n}-live.png`);
      }
      if (options.verdict !== undefined) pass.verdict = options.verdict;
      entry.history.push(pass);
      return { activity: options.activity, slug };
    });
  },

  event() {
    let slug;
    let activity;
    if (positional.length === 2) [slug, activity] = positional;
    else [activity] = positional;
    if (!activity) fail(USAGE);
    withLock(() => {
      if (slug !== undefined) componentIn(readManifest(), slug);
      appendEvent(activity, slug);
    });
  },

  "take-queued"() {
    const taken = change((manifest) => {
      let queue = { requests: [] };
      try {
        queue = JSON.parse(readFileSync(paths.queue, "utf8"));
      } catch {}
      const request = queue.requests.find((r) => r.slug === EVERYTHING || manifest.components.some((c) => c.slug === r.slug));
      if (!request) return { slug: null };
      writeJsonAtomic(paths.queue, { requests: queue.requests.filter((r) => r.slug !== request.slug) });
      if (request.slug === EVERYTHING) return { slug: EVERYTHING };
      const entry = componentIn(manifest, request.slug);
      entry.status = "queued";
      unbuild(entry);
      manifest.completedAt = null;
      return { activity: `Queued ${entry.name}; the import builds it next`, slug: request.slug };
    });
    if (taken.slug !== null) console.log(taken.slug);
  },

  survey() {
    const [theme, json] = positional;
    if (!THEMES.includes(theme)) fail("survey needs light or dark and its capture JSON");
    const evidence = readJsonArg(json);
    change((manifest) => {
      if (!manifest.startedAt || evidence.run !== manifest.startedAt) fail("The import changed during the survey; survey again.");
      manifest.verification ??= { surveys: {}, checks: {} };
      manifest.verification.surveys[theme] = { run: manifest.startedAt, palette: paletteDigest(evidence.palette), capturedAt: evidence.capturedAt };
      manifest.completedAt = null;
      return { activity: `Read the product's ${theme} colours` };
    });
  },

  checks() {
    const [slug, theme, json] = positional;
    if (!THEMES.includes(theme)) fail("checks needs a component, theme and results JSON");
    const evidence = readJsonArg(json);
    change((manifest) => {
      componentIn(manifest, slug);
      if (evidence.run !== manifest.startedAt || evidence.fingerprint !== checkFingerprint(libraryDir, manifest, slug, theme)) fail("The component or palette changed during the check; check again.");
      manifest.verification ??= { surveys: {}, checks: {} };
      manifest.verification.checks[slug] ??= {};
      manifest.verification.checks[slug][theme] ??= {};
      for (const state of evidence.states) {
        manifest.verification.checks[slug][theme][state.state] = { fingerprint: evidence.fingerprint, verdict: state.verdict, typecheck: evidence.typecheck === true };
      }
      manifest.completedAt = null;
    });
  },

  stages() {
    change((manifest) => {
      manifest.importStages ??= STAGES.map((id) => ({ id }));
    });
  },

  stage() {
    const [stage, action] = positional;
    if (action !== "complete") fail("stage needs <foundations|core|extended> complete");
    change((manifest) => {
      try { completeStage(libraryDir, manifest, stage); } catch (error) { fail(error.message); }
      return { activity: `${manifest.importStages.find((s) => s.id === stage).title} done` };
    });
  },

  complete() {
    change((manifest) => {
      try { requireAllStages(libraryDir, manifest); } catch (error) { fail(error.message); }
      const problems = completionProblems(libraryDir, manifest);
      if (problems.length) fail(problems.join("\n"));
      manifest.completedAt ??= now();
      return { activity: `Finished: ${coverage(manifest.components)}` };
    });
  },
};

// The one line that says how far the import got, in the shape the app
// reads it everywhere: "5 of 6 built, 1 skipped".
function coverage(components) {
  const built = components.filter((c) => c.status === "done").length;
  const skipped = components.filter((c) => c.status === "skipped").length;
  const parts = [`${built} of ${components.length} built`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return parts.join(", ");
}

function checkToken(token) {
  requireString(token.name, "token.name");
  if (!/^[A-Za-z0-9_-]+$/.test(token.name)) fail("token.name may contain only letters, digits, underscores and dashes so it can be a stable CSS variable");
  requireString(token.value, "token.value");
  requireString(token.group, "token.group");
  if (token.role !== undefined && token.role !== "surface" && token.role !== "text") fail("token.role is surface or text");
}

function checkType(style) {
  requireString(style.name, "type.name");
  requireString(style.family, "type.family");
  requireString(style.size, "type.size");
  requireString(style.lineHeight, "type.lineHeight");
  requireString(style.sample, "type.sample");
  if (typeof style.weight !== "number") fail("type.weight must be a number");
}

// Replace the entry of the same name, else add it at the end.
function putByName(list, item) {
  const existing = list.findIndex((t) => t.name === item.name);
  if (existing === -1) list.push(item);
  else list[existing] = item;
}

// What the unit authored in src/components/<slug>/: the module, its
// states and the tokens it uses, checked here so a done component
// always renders and never names a colour the palette lacks.
function authored(slug, themes) {
  const folder = join(paths.modules, slug);
  if (!existsSync(folder)) fail(`${folder} does not exist; the unit authors the component there before it is done`);
  const modules = readdirSync(folder).filter((name) => /^[A-Z][A-Za-z0-9]*\.tsx$/.test(name));
  if (modules.length !== 1) fail(`${folder} must hold exactly one <Slug>.tsx module; found ${modules.join(", ") || "none"}`);
  const source = readFileSync(join(folder, modules[0]), "utf8");
  if (!/export default /.test(source)) fail(`${modules[0]} needs a default export: the component`);
  if (!/\.module\.css/.test(source)) fail(`${modules[0]} must style itself from a scoped <Slug>.module.css beside it`);
  const shape = `{ "states": [{ "name": "Default", "props": {} }, …], "tokens": { "light": ["slate-900"], "dark": ["slate-900"] } }`;
  let unit;
  try {
    unit = JSON.parse(readFileSync(join(folder, "component.json"), "utf8"));
  } catch {
    fail(`${folder}/component.json is missing or not JSON: ${shape}`);
  }
  if (typeof unit !== "object" || unit === null || Array.isArray(unit)) fail(`${folder}/component.json must be an object: ${shape}`);
  const { states } = unit;
  if (!Array.isArray(states) || states.length === 0) fail(`${folder}/component.json must list at least the default state under "states"`);
  for (const state of states) {
    requireString(state.name, "state.name");
    if (typeof state.props !== "object" || state.props === null || Array.isArray(state.props)) fail(`state "${state.name}" needs a props object`);
    if (state.width !== undefined && !(typeof state.width === "number" && state.width > 0)) fail(`state "${state.name}": width is the product's width in CSS px, a positive number`);
  }
  if (new Set(states.map((s) => s.name)).size !== states.length) fail("state names must be unique");
  const componentTokens = Array.isArray(unit.tokens) ? { light: unit.tokens, dark: unit.tokens } : unit.tokens;
  if (!componentTokens || !THEMES.every((theme) => Array.isArray(componentTokens[theme]))) fail(`${folder}/component.json must list the manifest tokens the component uses under "tokens.light" and "tokens.dark"`);
  for (const theme of THEMES) for (const name of componentTokens[theme]) {
    requireString(name, `tokens.${theme}[]`);
    if (!themes[theme].some((t) => t.name === name)) fail(`component.json names the ${theme} token "${name}", which the manifest does not hold; push it with \`token ${theme}\` first`);
  }
  const record = { module: ["src", "components", slug, modules[0]].join("/"), states, tokens: Object.fromEntries(THEMES.map((theme) => [theme, [...new Set(componentTokens[theme])]])) };
  if (unit.backdrop !== undefined) {
    requireString(unit.backdrop, "backdrop");
    record.backdrop = unit.backdrop;
  }
  if (unit.unverified !== undefined) {
    requireString(unit.unverified, "unverified");
    if (unit.unverified.length > REASON_CAP) fail(`unverified is ${unit.unverified.length} characters; the cap is ${REASON_CAP}: one plain sentence for the user`);
    record.unverified = unit.unverified;
  }
  return record;
}

// The folders under src/components/ that an import wrote: the ones
// carrying component.json. The app's own components never do.
function importedModules() {
  try {
    return readdirSync(paths.modules).filter((name) => existsSync(join(paths.modules, name, "component.json")));
  } catch {
    return [];
  }
}

// A component that is not built right now has no module, states or
// tokens; the product crop, if it has one, stays: it is the product's
// own picture of the component and outlives every retry.
function unbuild(entry) {
  delete entry.module;
  delete entry.unverified;
  delete entry.backdrop;
  entry.states = [];
  entry.tokens = { light: [], dark: [] };
}

// A component being read again, or built, is no longer skipped.
function forget(entry) {
  delete entry.reason;
  delete entry.skipKind;
}

function statusActivity(status, name) {
  switch (status) {
    case "found":
      return `Found ${name}`;
    case "extracting":
      return `Reading ${name} on the live page`;
    case "done":
      return `Built ${name}`;
    case "skipped":
      return `Could not build ${name}`;
    case "queued":
      return `Queued ${name}; the import builds it next`;
  }
}

// Passes are numbered by the folder, not the manifest, so a number is
// never reused.
function nextPass(folder) {
  let last = 0;
  for (const name of readdirSync(folder)) {
    const match = /^(\d+)\.png$/.exec(name);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return last + 1;
}

// A rename fails across filesystems (a unit folder on another volume): copy then remove.
function renameOrCopy(from, to) {
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

const run = commands[subcommand];
if (!run) fail(`unknown subcommand "${subcommand}"\n${USAGE}`);
run();
