#!/usr/bin/env node
/**
 * Plays a recorded design-system import into a library app, at a
 * realistic pace, through the same writer the real import uses
 * (tools/library.mjs, docs/library-contract.md): so the files it
 * leaves behind are exactly what a real run leaves behind, and the
 * order it writes them in is the real skill's order. Once complete it
 * watches public/queue.json and builds a component the user queues
 * from the app, or starts the whole import again when the user asks
 * for that.
 *
 * The recording is of "Meridian", a fictional expense product: every
 * name below (codebase, tokens, components, copy) is that fixture's
 * data, not a default anything inherits. The fixture PNGs are the
 * product crops of the two skipped components and every component's
 * verification passes: each pass's replica and diff were captured
 * with the kit's own tools (tools/cdp/headless.mjs, capture.mjs,
 * diff.mjs) from the app's render route showing the fixture's own
 * default state, the first pass with a deliberate slip, the last one
 * clean.
 *
 * Usage: node run.mjs <library-dir> [--fast]
 *   <library-dir> is the library app's folder (the one holding
 *   package.json and public/). Serve it with `pnpm dev` and watch.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { checkFingerprint } from "../import-evidence.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures/meridian");
const LIBRARY_MJS = join(HERE, "..", "library.mjs");

const [libraryDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fast = process.argv.includes("--fast");
if (!libraryDir) {
  console.error("usage: node run.mjs <library-dir> [--fast]");
  process.exit(1);
}
const speed = fast ? 0.15 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));

// One line per write, exactly as the skill runs it. library.mjs prints
// the event it appended; that is this driver's log.
const lib = (...args) => {
  execFileSync(process.execPath, [LIBRARY_MJS, ...args], { stdio: ["ignore", "inherit", "inherit"] });
};
const libOut = (...args) => execFileSync(process.execPath, [LIBRARY_MJS, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const LIGHT_TOKENS = [
  { name: "slate-50", value: "#f8fafc", group: "gray", role: "surface" },
  { name: "slate-100", value: "#f1f5f9", group: "gray" },
  { name: "slate-200", value: "#e2e8f0", group: "gray" },
  { name: "slate-300", value: "#cbd5e1", group: "gray" },
  { name: "slate-500", value: "#64748b", group: "gray" },
  { name: "slate-600", value: "#475569", group: "gray" },
  { name: "slate-700", value: "#334155", group: "gray" },
  { name: "slate-900", value: "#0f172a", group: "gray", role: "text" },
  { name: "indigo-100", value: "#e0e7ff", group: "brand" },
  { name: "indigo-500", value: "#6366f1", group: "brand" },
  { name: "indigo-600", value: "#4f46e5", group: "brand" },
  { name: "indigo-700", value: "#4338ca", group: "brand" },
  { name: "emerald-500", value: "#10b981", group: "semantic" },
  { name: "emerald-700", value: "#047857", group: "semantic" },
  { name: "amber-500", value: "#f59e0b", group: "semantic" },
  { name: "amber-700", value: "#b45309", group: "semantic" },
  { name: "red-500", value: "#ef4444", group: "semantic" },
  { name: "red-700", value: "#b91c1c", group: "semantic" },
  { name: "primary-foreground", value: "#ffffff", group: "semantic" },
  { name: "control-surface", value: "#ffffff", group: "semantic" },
  { name: "control-hover", value: "#f8fafc", group: "semantic" },
  { name: "danger-border", value: "#fecaca", group: "semantic" },
  { name: "danger-hover", value: "#fef2f2", group: "semantic" },
];

const DARK_VALUES = {
  "slate-50": "#111827",
  "slate-100": "#1f2937",
  "slate-200": "#334155",
  "slate-300": "#475569",
  "slate-500": "#94a3b8",
  "slate-600": "#cbd5e1",
  "slate-700": "#e2e8f0",
  "slate-900": "#f8fafc",
  "indigo-100": "#312e81",
  "indigo-500": "#818cf8",
  "indigo-600": "#6366f1",
  "indigo-700": "#a5b4fc",
  "emerald-500": "#34d399",
  "emerald-700": "#6ee7b7",
  "amber-500": "#fbbf24",
  "amber-700": "#fde68a",
  "red-500": "#f87171",
  "red-700": "#fca5a5",
  "primary-foreground": "#111827",
  "control-surface": "#111827",
  "control-hover": "#1f2937",
  "danger-border": "#7f1d1d",
  "danger-hover": "#450a0a",
};
const DARK_TOKENS = LIGHT_TOKENS.map((token) => ({
  ...token,
  value: DARK_VALUES[token.name] ?? token.value,
}));

const TYPE = [
  { name: "Heading L", family: "Inter", size: "24px", weight: 650, lineHeight: "32px", sample: "Expense report: September" },
  { name: "Heading S", family: "Inter", size: "16px", weight: 600, lineHeight: "24px", sample: "Pending approvals" },
  { name: "Body", family: "Inter", size: "13px", weight: 450, lineHeight: "20px", sample: "Receipts are matched automatically when a card transaction settles." },
  { name: "Caption", family: "Inter", size: "11.5px", weight: 500, lineHeight: "16px", sample: "CARD ··4921 · POSTED SEP 16" },
];

// Each component's module (a TSX component, its scoped stylesheet and
// component.json, in fixtures/meridian/components/<slug>/) and its
// verification passes, the activity of each written for the user in
// the product's terms. A skipped component carries its kind and
// reason, and what happens when the user queues it: the date picker
// comes back built, the toast is looked for again and not found.
const COMPONENTS = [
  {
    slug: "button", name: "Button",
    history: [
      { mismatch: 3296, activity: "First try: the corners are too round and the label is too bold" },
      { mismatch: 350, activity: "The right padding is 2px short; widening" },
      { mismatch: 0, activity: "Matches the product" },
    ],
  },
  {
    slug: "input", name: "Input",
    history: [
      { mismatch: 4248, activity: "The border is a shade too dark and the hint sits 1px low" },
      { mismatch: 0, activity: "Matches the product" },
    ],
  },
  {
    slug: "badge", name: "Status badge",
    history: [
      { mismatch: 1495, activity: "The dot is 1px too far from the label" },
      { mismatch: 0, activity: "Matches the product" },
    ],
  },
  {
    slug: "date-picker", name: "Date picker",
    skip: { kind: "could-not-isolate", reason: "The calendar only exists while it is open over the page, so the import could not capture it on its own." },
    retry: {
      history: [
        { mismatch: 3356, activity: "The picked day is the wrong blue and the arrows sit 1px high" },
        { mismatch: 0, activity: "Matches the product" },
      ],
    },
  },
  {
    slug: "card", name: "Expense card",
    history: [
      { mismatch: 1213, activity: "The shadow is missing and the amount is not bold enough" },
      { mismatch: 0, activity: "Matches the product" },
    ],
  },
  {
    slug: "table", name: "Expense table",
    history: [
      { mismatch: 71046, activity: "Rows are 2px short and the header is not in capitals" },
      { mismatch: 0, activity: "Matches the product" },
    ],
  },
  {
    slug: "toast", name: "Toast",
    skip: { kind: "not-tried", reason: "A toast shows for a few seconds after an action, and none was on the page while the import looked." },
    retry: {
      skip: { kind: "could-not-isolate", reason: "No toast was showing when the import looked again; save an expense in Meridian, then queue it once more." },
    },
  },
];

// A unit folder per component holds the pass images verify-replica.mjs
// wrote, which `history` moves into the library. The component itself
// is authored straight into the app, src/components/<slug>/, the way a
// unit does, and `status done` reads it from there.
const run = await mkdtemp(join(tmpdir(), "fake-import-"));
const unitOf = (slug) => join(run, "units", slug);
const moduleOf = (slug) => join(libraryDir, "src", "components", slug);
const unitFile = (slug) => JSON.parse(readFileSync(join(FIXTURES, "components", slug, "component.json"), "utf8"));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

async function build(spec, history, tokensReady = Promise.resolve()) {
  const unit = unitOf(spec.slug);
  await mkdir(join(unit, "passes"), { recursive: true });
  lib("component", libraryDir, spec.slug, "status", "extracting");
  await sleep(900);
  lib("event", libraryDir, spec.slug, `Rebuilding ${spec.name} from what the page shows`);
  await sleep(700);
  for (const theme of ["light", "dark"]) {
    for (const [i, pass] of history.entries()) {
      const n = i + 1;
      const screenshot = join(unit, "passes", `${theme}-${n}.png`);
      const diff = join(unit, "passes", `${theme}-${n}-diff.png`);
      await copyFile(join(FIXTURES, "components", spec.slug, "history", `${n}.png`), screenshot);
      await copyFile(join(FIXTURES, "components", spec.slug, "history", `${n}-diff.png`), diff);
      lib("history", libraryDir, spec.slug, "--theme", theme, "--screenshot", screenshot, "--diff", diff, "--mismatch", String(pass.mismatch), "--activity", `${theme === "dark" ? "Dark" : "Light"}: ${pass.activity}`);
      await sleep(550);
    }
  }
  await tokensReady;
  await cp(join(FIXTURES, "components", spec.slug), moduleOf(spec.slug), {
    recursive: true,
    filter: (source) => !/\.png$/.test(source) && !/[\/]history$/.test(source),
  });
  const { states, tokens } = unitFile(spec.slug);
  for (const state of states) {
    lib("event", libraryDir, spec.slug, `Captured the ${state.name.toLowerCase()} state of ${spec.name}`);
    await sleep(500);
  }
  let tokenCount = tokens.length;
  if (!Array.isArray(tokens)) {
    tokenCount = new Set([...tokens.light, ...tokens.dark]).size;
  }
  lib("event", libraryDir, spec.slug, `${spec.name} uses ${plural(tokenCount, "colour")} from the palette`);
  await sleep(400);
  lib("component", libraryDir, spec.slug, "status", "done");
}

async function skip(spec, { kind, reason }) {
  lib("component", libraryDir, spec.slug, "status", "extracting");
  await sleep(1200);
  lib("component", libraryDir, spec.slug, "status", "skipped", "--kind", kind, "--reason", reason, "--screenshot", join(FIXTURES, "components", spec.slug, "screenshot.png"));
}

// The skill's order: open the run, flush the whole inventory, fan out,
// then stream tokens and type styles while the units run. The tokens
// land before any unit does, since `done` checks the ones it names.
async function play() {
  lib("init", libraryDir, "meridian", "meridian-web", "--page-url", "https://app.meridian.example/expenses", "--page-title", "Expenses · Meridian", "--favicon", join(FIXTURES, "favicon.svg"));
  await sleep(1800);
  lib("inventory", libraryDir, JSON.stringify(COMPONENTS.map((c) => ({ slug: c.slug, name: c.name }))));
  await sleep(600);

  const stream = (async () => {
    await sleep(400);
    for (const [theme, tokens] of [["light", LIGHT_TOKENS], ["dark", DARK_TOKENS]]) {
      for (const token of tokens) {
        lib("token", libraryDir, theme, JSON.stringify(token));
        await sleep(10);
      }
    }
    for (const s of TYPE) {
      lib("type", libraryDir, JSON.stringify(s));
      await sleep(550);
    }
  })();

  // One lane per component, every one of them started at once, each a
  // beat behind the last, the way the real import fans out. A fast unit
  // waits at landing until both palettes have finished streaming.
  const lanes = Promise.all(
    COMPONENTS.map(async (spec, i) => {
      await sleep(i * 350);
      if (spec.skip) await skip(spec, spec.skip);
      else await build(spec, spec.history, stream);
    }),
  );

  await Promise.all([lanes, stream]);
  complete();
}

function complete() {
  // This driver simulates the import from fixtures, including verification.
  // Real imports record evidence only through survey.mjs and check.mjs.
  const readManifest = () => JSON.parse(readFileSync(join(libraryDir, "public", "manifest.json"), "utf8"));
  let manifest = readManifest();
  for (const theme of ["light", "dark"]) {
    lib("survey", libraryDir, theme, JSON.stringify({ run: manifest.startedAt, palette: manifest.themes[theme], capturedAt: "fixture" }));
  }
  manifest = readManifest();
  for (const component of manifest.components.filter((entry) => entry.status === "done")) {
    const unit = JSON.parse(readFileSync(join(libraryDir, "src", "components", component.slug, "component.json"), "utf8"));
    for (const theme of ["light", "dark"]) {
      lib("checks", libraryDir, component.slug, theme, JSON.stringify({
        run: manifest.startedAt, fingerprint: checkFingerprint(libraryDir, manifest, component.slug, theme),
        typecheck: true, states: unit.states.map((state) => ({ state: state.name, verdict: "match" })),
      }));
    }
  }
  lib("complete", libraryDir);
  console.log("✓ complete");
}

// The app's "Queue it" adds { slug, at } to queue.json, and "Import
// again" adds it with the slug "*". take-queued pops one request: a
// component's marks it queued and clears completedAt, so the app keeps
// polling, and the driver builds it like any other and completes
// again; "*" restarts the whole recording. It watches for ninety
// seconds after each finish.
async function watch() {
  const deadline = Date.now() + 90_000 * speed;
  console.log(`watching public/queue.json for ${Math.round((deadline - Date.now()) / 1000)}s (press "Queue it" or "Import again" in the app)`);
  while (Date.now() < deadline) {
    const slug = libOut("take-queued", libraryDir).trim().split("\n").pop();
    if (slug === "*") return "again";
    const spec = COMPONENTS.find((c) => c.slug === slug);
    if (!spec) {
      await sleep(1000 / speed);
      continue;
    }
    await sleep(4000);
    if (spec.retry.skip) await skip(spec, spec.retry.skip);
    else await build(spec, spec.retry.history);
    complete();
  }
  return "done";
}

let next = "again";
while (next === "again") {
  await play();
  next = await watch();
}
await rm(run, { recursive: true, force: true });
