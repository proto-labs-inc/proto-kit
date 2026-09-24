#!/usr/bin/env node
/**
 * Plays a recorded design-system import into a library app, at a
 * realistic pace, through the same writer the real import uses
 * (tools/library.mjs, docs/library-contract.md): so the files it
 * leaves behind are exactly what a real run leaves behind, and the
 * order it writes them in is the real skill's order. Once complete it
 * watches public/queue.json and extracts a component the user queues
 * from the app.
 *
 * The recording is of "Meridian", a fictional expense product: every
 * name below (codebase, tokens, components, copy) is that fixture's
 * data, not a default anything inherits. The fixture PNGs (the date
 * picker's product screenshot, the button's replica passes and diffs)
 * were rendered from HTML pages of the same data.
 *
 * Usage: node run.mjs <library-dir> [--fast]
 *   <library-dir> is the library app's folder (the one holding
 *   package.json and public/). Serve it with `pnpm dev` and watch.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const TOKENS = [
  { name: "slate-50", value: "#f8fafc", group: "gray", role: "surface" },
  { name: "slate-100", value: "#f1f5f9", group: "gray" },
  { name: "slate-300", value: "#cbd5e1", group: "gray" },
  { name: "slate-500", value: "#64748b", group: "gray" },
  { name: "slate-700", value: "#334155", group: "gray" },
  { name: "slate-900", value: "#0f172a", group: "gray", role: "text" },
  { name: "indigo-600", value: "#4f46e5", group: "brand" },
  { name: "indigo-500", value: "#6366f1", group: "brand" },
  { name: "emerald-500", value: "#10b981", group: "semantic" },
  { name: "amber-500", value: "#f59e0b", group: "semantic" },
  { name: "red-500", value: "#ef4444", group: "semantic" },
];

const TYPE = [
  { name: "Heading L", family: "Inter", size: "24px", weight: 650, lineHeight: "32px", sample: "Expense report: September" },
  { name: "Heading S", family: "Inter", size: "16px", weight: 600, lineHeight: "24px", sample: "Pending approvals" },
  { name: "Body", family: "Inter", size: "13px", weight: 450, lineHeight: "20px", sample: "Receipts are matched automatically when a card transaction settles." },
  { name: "Caption", family: "Inter", size: "11.5px", weight: 500, lineHeight: "16px", sample: "CARD ··4921 · POSTED SEP 16" },
];

// Each component's states, in the order the app shows them: the first
// is the default. `history` is the button's three verification passes.
const COMPONENTS = [
  {
    slug: "button", name: "Button", category: "primitive",
    states: [
      { name: "Default", file: "default.html", height: 110 },
      { name: "Hover", file: "hover.html", height: 110 },
      { name: "Disabled", file: "disabled.html", height: 110 },
      { name: "Loading", file: "loading.html", height: 110 },
    ],
    history: [
      { mismatch: 4212, activity: "Rendered the replica at the live coordinates; radius and weight are off" },
      { mismatch: 388, activity: "Padding is 2px short on the right; widening" },
      { mismatch: 0, activity: "Pixel-clean at threshold 8" },
    ],
  },
  {
    slug: "input", name: "Input", category: "primitive",
    states: [
      { name: "Default", file: "default.html", height: 150 },
      { name: "Focused", file: "focused.html", height: 110 },
      { name: "Error", file: "error.html", height: 110 },
    ],
  },
  {
    slug: "badge", name: "Status badge", category: "primitive",
    states: [{ name: "Default", file: "default.html", height: 90 }],
  },
  {
    slug: "date-picker", name: "Date picker", category: "primitive",
    skip: "Rendered inside a portal, so it could not be isolated cleanly. Queue it to try again with the calendar open.",
    states: [{ name: "Default", file: "default.html", height: 270 }],
  },
  {
    slug: "card", name: "Expense card", category: "composite",
    states: [
      { name: "Default", file: "default.html", height: 190 },
      { name: "Selected", file: "selected.html", height: 190 },
    ],
  },
  {
    slug: "table", name: "Expense table", category: "composite",
    states: [
      { name: "Default", file: "default.html", height: 250 },
      { name: "Empty", file: "empty.html", height: 160 },
    ],
  },
];

// A unit folder per component, as a sub-agent would leave it: the
// pass images verify-replica.mjs wrote, which `history` moves into the
// library, and the state files, which `state` copies.
const run = await mkdtemp(join(tmpdir(), "fake-import-"));
const unitOf = (slug) => join(run, "units", slug);

async function extract(spec) {
  const unit = unitOf(spec.slug);
  await mkdir(join(unit, "passes"), { recursive: true });
  lib("component", libraryDir, spec.slug, "status", "extracting");
  await sleep(900);
  lib("event", libraryDir, spec.slug, `Authoring ${spec.name} from its matched rules`);
  await sleep(700);
  for (const [i, pass] of (spec.history ?? []).entries()) {
    const n = i + 1;
    const screenshot = join(unit, "passes", `${n}.png`);
    const diff = join(unit, "passes", `${n}-diff.png`);
    await copyFile(join(FIXTURES, "components", spec.slug, "history", `${n}.png`), screenshot);
    await copyFile(join(FIXTURES, "components", spec.slug, "history", `${n}-diff.png`), diff);
    lib("history", libraryDir, spec.slug, "--screenshot", screenshot, "--diff", diff, "--mismatch", String(pass.mismatch), "--activity", pass.activity);
    await sleep(1100);
  }
  for (const state of spec.states) {
    lib("state", libraryDir, spec.slug, state.name, join(FIXTURES, "components", spec.slug, state.file), String(state.height));
    await sleep(500);
  }
  lib("component", libraryDir, spec.slug, "status", "done");
}

async function skip(spec) {
  lib("component", libraryDir, spec.slug, "status", "extracting");
  await sleep(1200);
  lib("component", libraryDir, spec.slug, "status", "skipped", "--reason", spec.skip, "--screenshot", join(FIXTURES, "components", spec.slug, "screenshot.png"));
}

// The skill's order: open the run, flush the whole inventory, fan out,
// then stream tokens and type styles while the units run.
lib("init", libraryDir, "meridian", "meridian-web");
await sleep(1800);
lib("inventory", libraryDir, JSON.stringify(COMPONENTS.map((c) => ({ slug: c.slug, name: c.name, category: c.category }))));
await sleep(600);

// Four lanes at most, each a beat behind the last, the way the real
// import fans out.
const pending = [...COMPONENTS];
const lane = async (delay) => {
  await sleep(delay);
  while (pending.length > 0) {
    const spec = pending.shift();
    if (spec.skip) await skip(spec);
    else await extract(spec);
  }
};
const lanes = Promise.all([lane(0), lane(700), lane(1400), lane(2100)]);

const stream = async () => {
  await sleep(400);
  for (const t of TOKENS) {
    lib("token", libraryDir, JSON.stringify(t));
    await sleep(320);
  }
  for (const s of TYPE) {
    lib("type", libraryDir, JSON.stringify(s));
    await sleep(550);
  }
};
await Promise.all([lanes, stream()]);

function complete() {
  lib("complete", libraryDir);
  console.log("✓ complete");
}
complete();

// The app's "Queue it" button appends { slug, at } to queue.json.
// take-queued pops one request, marks the component queued and clears
// completedAt, so the app keeps polling; the driver then extracts it
// like any other and completes again. It watches for ninety seconds.
const deadline = Date.now() + 90_000 * speed;
console.log(`watching public/queue.json for ${Math.round((deadline - Date.now()) / 1000)}s (press "Queue it" in the app)`);
while (Date.now() < deadline) {
  const slug = libOut("take-queued", libraryDir).trim().split("\n").pop();
  const spec = COMPONENTS.find((c) => c.slug === slug);
  if (!spec) {
    await sleep(1000 / speed);
    continue;
  }
  await sleep(4000);
  await extract(spec);
  complete();
}
await rm(run, { recursive: true, force: true });
