#!/usr/bin/env node
/**
 * Plays a recorded design-system import into a library app, at a
 * realistic pace, writing exactly the contract the real import skill
 * writes (docs/library-contract.md): public/manifest.json,
 * public/events.jsonl, public/components/<slug>/<state>.html, a
 * skipped component's screenshot, a component's iteration history,
 * and, once complete, watches public/queue.json and extracts a
 * component the user queues from the app.
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
import { copyFile, mkdir, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/meridian");

const [libraryDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fast = process.argv.includes("--fast");
if (!libraryDir) {
  console.error("usage: node run.mjs <library-dir> [--fast]");
  process.exit(1);
}
const publicDir = join(libraryDir, "public");
const speed = fast ? 0.15 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));
const now = () => new Date().toISOString();

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

const manifest = {
  codebase: "meridian",
  source: "meridian-web",
  product: {
    name: "Meridian",
    pageUrl: "https://app.meridian.example/expenses",
    pageTitle: "Expenses · Meridian",
  },
  startedAt: now(),
  completedAt: null,
  tokens: [],
  type: [],
  components: [],
};

// Writes are serialised: components extract in parallel, and the
// manifest must never be written half-way through another write.
let writing = Promise.resolve();
const serial = (work) => {
  writing = writing.then(work, work);
  return writing;
};
const flush = () =>
  serial(() => writeFile(join(publicDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"));
const event = (activity, component) => {
  const line = { at: now(), ...(component && { component }), activity };
  console.log(component ? `· [${component}] ${activity}` : `· ${activity}`);
  return serial(() => appendFile(join(publicDir, "events.jsonl"), JSON.stringify(line) + "\n"));
};
const readQueue = async () => JSON.parse(await readFile(join(publicDir, "queue.json"), "utf8"));
const writeQueue = (queue) =>
  serial(() => writeFile(join(publicDir, "queue.json"), JSON.stringify(queue, null, 2) + "\n"));

async function extract(spec) {
  const entry = manifest.components.find((c) => c.slug === spec.slug);
  const folder = join(publicDir, "components", spec.slug);
  await mkdir(folder, { recursive: true });
  entry.status = "extracting";
  await flush();
  await event(`Reading ${spec.name} on the live page`, spec.slug);
  await sleep(900);
  await event(`Authoring ${spec.name} from its matched rules`, spec.slug);
  await sleep(700);
  for (const [i, pass] of (spec.history ?? []).entries()) {
    await mkdir(join(folder, "history"), { recursive: true });
    const n = i + 1;
    await copyFile(join(FIXTURES, "components", spec.slug, "history", `${n}.png`), join(folder, "history", `${n}.png`));
    await copyFile(join(FIXTURES, "components", spec.slug, "history", `${n}-diff.png`), join(folder, "history", `${n}-diff.png`));
    entry.history.push({
      at: now(),
      activity: pass.activity,
      screenshot: `components/${spec.slug}/history/${n}.png`,
      diff: `components/${spec.slug}/history/${n}-diff.png`,
      mismatch: pass.mismatch,
    });
    await flush();
    await event(`${pass.activity} (${pass.mismatch.toLocaleString()} pixels off)`, spec.slug);
    await sleep(1100);
  }
  for (const state of spec.states) {
    await copyFile(join(FIXTURES, "components", spec.slug, state.file), join(folder, state.file));
    entry.states.push({ name: state.name, file: `components/${spec.slug}/${state.file}`, height: state.height });
    await flush();
    await event(`Captured the ${state.name.toLowerCase()} state of ${spec.name}`, spec.slug);
    await sleep(500);
  }
  entry.status = "done";
  await flush();
  await event(`Extracted ${spec.name}`, spec.slug);
}

async function skip(spec) {
  const entry = manifest.components.find((c) => c.slug === spec.slug);
  const folder = join(publicDir, "components", spec.slug);
  await mkdir(folder, { recursive: true });
  entry.status = "extracting";
  await flush();
  await event(`Reading ${spec.name} on the live page`, spec.slug);
  await sleep(1200);
  await copyFile(join(FIXTURES, "components", spec.slug, "screenshot.png"), join(folder, "screenshot.png"));
  entry.status = "skipped";
  entry.reason = spec.skip;
  entry.screenshot = `components/${spec.slug}/screenshot.png`;
  await flush();
  await event(`Skipping ${spec.name}`, spec.slug);
}

// A fresh run: the app tolerates a manifest that grows, never one that
// shrinks, so the previous run's files go before the first write.
await rm(join(publicDir, "components"), { recursive: true, force: true });
await writeFile(join(publicDir, "events.jsonl"), "");
await writeQueue({ requests: [] });
await flush();
await event("Reading the source");
await sleep(1800);

await event("Extracting color tokens");
for (const t of TOKENS) {
  manifest.tokens.push(t);
  await flush();
  await event(`Extracting color tokens (${t.name})`);
  await sleep(320);
}

await event("Extracting type styles");
for (const s of TYPE) {
  manifest.type.push(s);
  await flush();
  await event(`Extracting type styles (${s.name})`);
  await sleep(550);
}

manifest.components = COMPONENTS.map((c) => ({
  slug: c.slug,
  name: c.name,
  category: c.category,
  status: "found",
  states: [],
  history: [],
}));
await flush();
await event(`Found ${COMPONENTS.length} components`);
await sleep(1200);

// Two at a time, the second lane a beat behind, the way the real
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
await Promise.all([lane(0), lane(1500)]);

async function complete() {
  manifest.completedAt = now();
  await flush();
  await event("Import complete");
  console.log("✓ complete");
}
await complete();

// The app's "Queue it" button appends { slug, at } to queue.json. The
// import takes each request off the queue, marks the component queued,
// and extracts it like any other; completedAt is cleared meanwhile so
// the app keeps polling. This driver watches for ninety seconds.
const skippable = COMPONENTS.filter((c) => c.skip);
const deadline = Date.now() + 90_000 * speed;
console.log(`watching public/queue.json for ${Math.round((deadline - Date.now()) / 1000)}s (press "Queue it" in the app)`);
while (Date.now() < deadline && manifest.components.some((c) => c.status === "skipped")) {
  const queue = await readQueue();
  const request = queue.requests.find((r) => skippable.some((c) => c.slug === r.slug));
  if (!request) {
    await sleep(1000 / speed);
    continue;
  }
  const spec = skippable.find((c) => c.slug === request.slug);
  const entry = manifest.components.find((c) => c.slug === spec.slug);
  await writeQueue({ requests: queue.requests.filter((r) => r.slug !== request.slug) });
  manifest.completedAt = null;
  entry.status = "queued";
  delete entry.reason;
  delete entry.screenshot;
  await flush();
  await event(`Queued ${spec.name}`, spec.slug);
  await sleep(4000);
  await extract(spec);
  await complete();
}
