#!/usr/bin/env node
/**
 * Plays a recorded design-system import against a library folder, at
 * realistic pace, writing the same contract the real import skill will
 * write: manifest.json, progress.json, components/*.html.
 *
 * The recording is of "Meridian", a fictional expense product — every
 * name below (product, tokens, components, copy) is that fixture's
 * data, not a default anything inherits.
 *
 * Usage: node run.mjs <library-dir> [--fast]
 */
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures/meridian");

const [target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fast = process.argv.includes("--fast");
if (!target) {
  console.error("usage: node run.mjs <library-dir> [--fast]");
  process.exit(1);
}
const speed = fast ? 0.15 : 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms * speed));

const TOKENS = [
  { name: "slate-900", value: "#0f172a", group: "gray" },
  { name: "slate-700", value: "#334155", group: "gray" },
  { name: "slate-500", value: "#64748b", group: "gray" },
  { name: "slate-300", value: "#cbd5e1", group: "gray" },
  { name: "slate-100", value: "#f1f5f9", group: "gray" },
  { name: "indigo-600", value: "#4f46e5", group: "brand" },
  { name: "indigo-500", value: "#6366f1", group: "brand" },
  { name: "emerald-500", value: "#10b981", group: "semantic" },
  { name: "amber-500", value: "#f59e0b", group: "semantic" },
  { name: "red-500", value: "#ef4444", group: "semantic" },
];

const TYPE = [
  { name: "Heading L", family: "Inter", size: "24px", weight: 650, lineHeight: "32px", sample: "Expense report — September" },
  { name: "Heading S", family: "Inter", size: "16px", weight: 600, lineHeight: "24px", sample: "Pending approvals" },
  { name: "Body", family: "Inter", size: "13px", weight: 450, lineHeight: "20px", sample: "Receipts are matched automatically when a card transaction settles." },
  { name: "Caption", family: "Inter", size: "11.5px", weight: 500, lineHeight: "16px", sample: "CARD ··4921 · POSTED SEP 16" },
];

const COMPONENTS = [
  { name: "Button", category: "primitive", file: "button.html", height: 110 },
  { name: "Input", category: "primitive", file: "input.html", height: 150 },
  { name: "Status badge", category: "primitive", file: "badge.html", height: 90 },
  { name: "Expense card", category: "composite", file: "card.html", height: 190 },
  { name: "Expense table", category: "composite", file: "table.html", height: 250 },
  { name: "Date picker", category: "primitive", skip: "Rendered inside a portal — couldn't isolate it cleanly. Will retry with the next import." },
];

const manifest = {
  product: "meridian",
  source: "meridian-web",
  startedAt: new Date().toISOString(),
  completedAt: null,
  tokens: [],
  type: [],
  components: [],
};

async function flush(activity, status = "importing") {
  await writeFile(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    join(target, "progress.json"),
    JSON.stringify({ status, activity, updatedAt: new Date().toISOString() }),
  );
  console.log(status === "complete" ? "✓ complete" : `· ${activity}`);
}

await mkdir(join(target, "components"), { recursive: true });
await flush("Reading the source…");
await sleep(1800);

await flush("Extracting color tokens…");
for (const t of TOKENS) {
  manifest.tokens.push(t);
  await flush(`Extracting color tokens… (${t.name})`);
  await sleep(320);
}

await flush("Extracting typography…");
for (const s of TYPE) {
  manifest.type.push(s);
  await flush(`Extracting typography… (${s.name})`);
  await sleep(550);
}

manifest.components = COMPONENTS.map((c) => ({
  name: c.name,
  category: c.category,
  status: "found",
  height: c.height,
}));
await flush(`Found ${COMPONENTS.length} components`);
await sleep(1200);

for (const [i, c] of COMPONENTS.entries()) {
  const entry = manifest.components[i];
  if (c.skip) {
    entry.status = "skipped";
    entry.reason = c.skip;
    await flush(`Skipping ${c.name}`);
    await sleep(700);
    continue;
  }
  entry.status = "extracting";
  await flush(`Extracting ${c.name}…`);
  await sleep(1400);
  await copyFile(join(FIXTURES, "components", c.file), join(target, "components", c.file));
  entry.status = "done";
  entry.file = `components/${c.file}`;
  await flush(`Extracted ${c.name}`);
  await sleep(500);
}

manifest.completedAt = new Date().toISOString();
await flush("Import complete", "complete");
