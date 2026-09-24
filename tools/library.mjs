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
 *   init <library> <codebase> <source> --page-url <url> --page-title "<title>" [--product-name "<name>"]
 *       A fresh run when no run is open (resets everything), a resume
 *       when one is; prints which. Appends "Reading the source". The
 *       product's name comes from --product-name, else from the page
 *       title ("Expenses · Meridian" names Meridian), else from the
 *       codebase's display name in codebase.json, never from its id.
 *   token <library> <json>            one { name, value, group, role? }
 *   type <library> <json>             one { name, family, size, weight, lineHeight, sample }
 *   inventory <library> <json>        every component at once, [{ slug, name }], all "found"
 *   component <library> <slug> status <found|extracting|done|skipped|queued>
 *       [--reason "<sentence>"] [--screenshot <png>] [--activity "<line>"]
 *       done reads the component the unit authored in
 *       src/components/<slug>/ (one <Slug>.tsx with a default export,
 *       its <Slug>.module.css, and states.json listing the named states
 *       as prop sets, the first being the default) and records its
 *       module path and states. skipped needs both: the reason, one plain sentence of at most
 *       140 characters in the product's terms, and the product crop
 *       (copied to components/<slug>/screenshot.png); queued clears both.
 *   history <library> <slug> --screenshot <png> --diff <png> --mismatch <n> --activity "<line>"
 *       Moves both images into components/<slug>/history/ and appends the
 *       pass; the oldest pass goes once there are more than ten.
 *   event <library> [slug] <activity>  one activity line, about a component or the whole import
 *   take-queued <library>             pops queue.json: prints the slug it took (now "queued",
 *                                     completedAt cleared) or nothing
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

const USAGE = `usage: node library.mjs <subcommand> <library> ...
  init <library> <codebase> <source> --page-url <url> --page-title <title> [--product-name <name>]
  token <library> <json>
  type <library> <json>
  inventory <library> <json array>
  component <library> <slug> status <found|extracting|done|skipped|queued> [--reason ...] [--screenshot ...] [--activity ...]
  history <library> <slug> --screenshot <png> --diff <png> --mismatch <n> --activity <line>
  event <library> [slug] <activity>
  take-queued <library>
  complete <library>`;
const STATUSES = ["found", "extracting", "done", "skipped", "queued"];
const HISTORY_CAP = 10;
const REASON_CAP = 140;
const STATE_CAP = 6;

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
  modules: join(libraryDir, "src", "components"),
  lock: join(publicDir, ".lock"),
};
const now = () => new Date().toISOString();

const EMPTY = { codebase: null, source: null, product: null, startedAt: null, completedAt: null, tokens: [], type: [], components: [] };

function readManifest() {
  try {
    return JSON.parse(readFileSync(paths.manifest, "utf8"));
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
    mkdirSync(paths.components, { recursive: true });
    const outcome = change((manifest) => {
      const open = manifest.startedAt !== null && manifest.completedAt === null;
      if (open) {
        Object.assign(manifest, { codebase, source, product });
        return { kind: "resumed", activity: "Resuming the import" };
      }
      rmSync(paths.components, { recursive: true, force: true });
      mkdirSync(paths.components, { recursive: true });
      for (const slug of importedModules()) rmSync(join(paths.modules, slug), { recursive: true, force: true });
      writeFileSync(paths.events, "");
      writeJsonAtomic(paths.queue, { requests: [] });
      Object.assign(manifest, { ...EMPTY, codebase, source, product, startedAt: now(), tokens: [], type: [], components: [] });
      return { kind: "fresh", activity: "Reading the source" };
    });
    console.log(`${outcome.kind}: ${libraryDir}`);
  },

  token() {
    const token = readJsonArg(positional[0]);
    requireString(token.name, "token.name");
    requireString(token.value, "token.value");
    requireString(token.group, "token.group");
    if (token.role !== undefined && token.role !== "surface" && token.role !== "text") fail("token.role is surface or text");
    change((manifest) => {
      const existing = manifest.tokens.findIndex((t) => t.name === token.name);
      if (existing === -1) manifest.tokens.push(token);
      else manifest.tokens[existing] = token;
      return { activity: `Extracting color tokens (${token.name})` };
    });
  },

  type() {
    const style = readJsonArg(positional[0]);
    requireString(style.name, "type.name");
    requireString(style.family, "type.family");
    requireString(style.size, "type.size");
    requireString(style.lineHeight, "type.lineHeight");
    requireString(style.sample, "type.sample");
    if (typeof style.weight !== "number") fail("type.weight must be a number");
    change((manifest) => {
      const existing = manifest.type.findIndex((t) => t.name === style.name);
      if (existing === -1) manifest.type.push(style);
      else manifest.type[existing] = style;
      return { activity: `Extracting type styles (${style.name})` };
    });
  },

  inventory() {
    const list = readJsonArg(positional[0]);
    if (!Array.isArray(list) || list.length === 0) fail("inventory takes a non-empty JSON array of { slug, name }");
    for (const item of list) {
      requireString(item.slug, "slug");
      requireString(item.name, "name");
      if (!/^[a-z0-9][a-z0-9-]*$/.test(item.slug)) fail(`slug "${item.slug}" must be lowercase letters, digits and dashes`);
    }
    change((manifest) => {
      for (const item of list) {
        if (manifest.components.some((c) => c.slug === item.slug)) continue;
        manifest.components.push({ slug: item.slug, name: item.name, status: "found", states: [], history: [] });
        mkdirSync(folderOf(item.slug), { recursive: true });
      }
      return { activity: `Found ${manifest.components.length} components` };
    });
  },

  component() {
    const [slug, keyword, status] = positional;
    if (!slug || keyword !== "status" || !STATUSES.includes(status)) fail(USAGE);
    if (status === "skipped") requireReason(options.reason);
    if (status === "skipped" && !options.screenshot) fail("skipped needs --screenshot, the component cropped to its own rect from the live page at 2x (tools/cdp/crop.mjs)");
    change((manifest) => {
      const entry = componentIn(manifest, slug);
      const folder = folderOf(slug);
      mkdirSync(folder, { recursive: true });
      entry.status = status;
      if (status === "skipped") {
        if (!existsSync(options.screenshot)) fail(`${options.screenshot} does not exist`);
        copyFileSync(options.screenshot, join(folder, "screenshot.png"));
        entry.reason = options.reason;
        entry.screenshot = relative(slug, "screenshot.png");
      } else {
        unskip(entry);
      }
      if (status === "done") Object.assign(entry, authored(slug));
      if (status === "queued") manifest.completedAt = null;
      return { activity: options.activity ?? statusActivity(status, entry.name), slug };
    });
  },

  history() {
    const [slug] = positional;
    const mismatch = Number(options.mismatch);
    if (!slug || !options.screenshot || !options.diff || !options.activity || !Number.isInteger(mismatch) || mismatch < 0) fail(USAGE);
    for (const image of [options.screenshot, options.diff]) if (!existsSync(image)) fail(`${image} does not exist`);
    change((manifest) => {
      const entry = componentIn(manifest, slug);
      const folder = join(folderOf(slug), "history");
      mkdirSync(folder, { recursive: true });
      const n = nextPass(folder);
      renameOrCopy(options.screenshot, join(folder, `${n}.png`));
      renameOrCopy(options.diff, join(folder, `${n}-diff.png`));
      entry.history.push({
        at: now(),
        activity: options.activity,
        screenshot: relative(slug, "history", `${n}.png`),
        diff: relative(slug, "history", `${n}-diff.png`),
        mismatch,
      });
      while (entry.history.length > HISTORY_CAP) {
        const dropped = entry.history.shift();
        for (const image of [dropped.screenshot, dropped.diff]) rmSync(join(publicDir, image), { force: true });
      }
      return { activity: `${options.activity} (${mismatch.toLocaleString()} pixels off)`, slug };
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
      const request = queue.requests.find((r) => manifest.components.some((c) => c.slug === r.slug));
      if (!request) return { slug: null };
      writeJsonAtomic(paths.queue, { requests: queue.requests.filter((r) => r.slug !== request.slug) });
      const entry = componentIn(manifest, request.slug);
      entry.status = "queued";
      unskip(entry);
      manifest.completedAt = null;
      return { activity: `Queued ${entry.name}`, slug: request.slug };
    });
    if (taken.slug !== null) console.log(taken.slug);
  },

  complete() {
    change((manifest) => {
      const moving = manifest.components.filter((c) => c.status !== "done" && c.status !== "skipped");
      if (moving.length > 0) fail(`still moving: ${moving.map((c) => `${c.slug} (${c.status})`).join(", ")}; finish or skip them first`);
      manifest.completedAt = now();
      return { activity: "Import complete" };
    });
  },
};

// What the unit authored in src/components/<slug>/: the module and its
// states, checked here so a done component always renders.
function authored(slug) {
  const folder = join(paths.modules, slug);
  if (!existsSync(folder)) fail(`${folder} does not exist; the unit authors the component there before it is done`);
  const modules = readdirSync(folder).filter((name) => /^[A-Z][A-Za-z0-9]*\.tsx$/.test(name));
  if (modules.length !== 1) fail(`${folder} must hold exactly one <Slug>.tsx module; found ${modules.join(", ") || "none"}`);
  const source = readFileSync(join(folder, modules[0]), "utf8");
  if (!/export default /.test(source)) fail(`${modules[0]} needs a default export: the component`);
  if (!/\.module\.css/.test(source)) fail(`${modules[0]} must style itself from a scoped <Slug>.module.css beside it`);
  let states;
  try {
    states = JSON.parse(readFileSync(join(folder, "states.json"), "utf8"));
  } catch {
    fail(`${folder}/states.json is missing or not JSON: [{ "name": "Default", "props": {} }, …]`);
  }
  if (!Array.isArray(states) || states.length === 0) fail(`${folder}/states.json must list at least the default state`);
  if (states.length > STATE_CAP) fail(`${folder}/states.json lists ${states.length} states; the cap is ${STATE_CAP}`);
  for (const state of states) {
    requireString(state.name, "state.name");
    if (typeof state.props !== "object" || state.props === null || Array.isArray(state.props)) fail(`state "${state.name}" needs a props object`);
  }
  if (new Set(states.map((s) => s.name)).size !== states.length) fail("state names must be unique");
  return { module: ["src", "components", slug, modules[0]].join("/"), states };
}

// The folders under src/components/ that an import wrote: the ones
// carrying states.json. The app's own components never do.
function importedModules() {
  try {
    return readdirSync(paths.modules).filter((name) => existsSync(join(paths.modules, name, "states.json")));
  } catch {
    return [];
  }
}

// A component leaving "skipped" loses the reason and the product crop.
function unskip(entry) {
  delete entry.reason;
  delete entry.module;
  entry.states = [];
  if (entry.screenshot) rmSync(join(publicDir, entry.screenshot), { force: true });
  delete entry.screenshot;
}

function statusActivity(status, name) {
  switch (status) {
    case "found":
      return `Found ${name}`;
    case "extracting":
      return `Reading ${name} on the live page`;
    case "done":
      return `Extracted ${name}`;
    case "skipped":
      return `Skipping ${name}`;
    case "queued":
      return `Queued ${name}`;
  }
}

// Passes are numbered by the folder, not the manifest, so a dropped
// pass never frees its number.
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
