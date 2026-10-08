#!/usr/bin/env node
/**
 * Turn the survey's draft into the import plan with a few edits: the
 * orchestrator's judgment, said briefly, applied here.
 *
 * Usage: node tools/plan.mjs <codebase> '<edits json>'   (or @file)
 *
 *   {
 *     "keep":  ["button-connect-github", "checkbox", …],   the draft components to import (the rest are left out);
 *                                                        omit to keep all but "drop"
 *     "drop":  ["card", "button-close-banner"],            left out
 *     "name":  { "button-connect-github": "Button",        the product's name for a component; its slug
 *                "form-field-organization": "FormItemLayout|form-item-layout" },   from the name, or after a |
 *     "looks": { "checkbox": { "Default": "Checked", "Look 2": "Unchecked" } },   the product's names for looks
 *     "merge": { "button-connect-github": { "button-feedback": "Text" } },   another draft component joins this
 *                                                        one as a look (its other looks come with it, "<look> <theirs>",
 *                                                        and its held states, "<look> hover")
 *     "stage": { "button-connect-github": "core", "table": "extended" }, // before or after renaming
 *     "add":   [ { "slug", "name", "states": [ … ] } ]      components the survey did not find
 *   }
 *
 * Reads ~/.proto/<codebase>/run/survey/plan.draft.json and writes
 * ~/.proto/<codebase>/run/plan.json, then prints one line per component.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DARK_MODE_IMPORT_ENABLED } from "./import-evidence.mjs";
import { componentStage } from "./import-stages.mjs";

const [codebase, editsArg] = process.argv.slice(2);
if (!codebase || !editsArg) {
  console.error("usage: node tools/plan.mjs <codebase> '<edits json>'");
  process.exit(1);
}
const run = join(process.env.HOME ?? "", ".proto", codebase, "run");
const survey = join(run, "survey");
let draftPath = join(survey, "plan.draft.json");
try { readFileSync(draftPath); } catch {
  draftPath = join(survey, "light", "plan.draft.json");
  if (DARK_MODE_IMPORT_ENABLED) {
    try { readFileSync(draftPath); } catch { draftPath = join(survey, "dark", "plan.draft.json"); }
  }
}
const draft = JSON.parse(readFileSync(draftPath, "utf8"));
let edits;
try {
  edits = JSON.parse(editsArg.startsWith("@") ? readFileSync(editsArg.slice(1), "utf8") : editsArg);
} catch {
  console.error("the edits are not JSON");
  process.exit(1);
}
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const bySlug = new Map(draft.components.map((c) => [c.slug, structuredClone(c)]));
const known = (slug, where) => {
  if (!bySlug.has(slug)) fail(`${where}: the draft has no component "${slug}" (see the survey's summary)`);
};
const slugOf = (text) => text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Merges first: a merged component's looks join its target, then it is gone.
for (const [target, joining] of Object.entries(edits.merge ?? {})) {
  known(target, "merge");
  const into = bySlug.get(target);
  for (const [other, look] of Object.entries(joining)) {
    known(other, `merge into ${target}`);
    const from = bySlug.get(other);
    // Every resting look comes: the first takes the given name, the rest
    // theirs after it; held states follow the look they were held on
    // (their "of", else the first).
    const renamed = new Map();
    from.states.filter((s) => !s.force).forEach((resting, k) => {
      const name = k === 0 ? look : `${look} ${resting.name.toLowerCase()}`;
      renamed.set(resting.name, name);
      into.states.push({ name, selector: resting.selector });
    });
    for (const held of from.states.filter((s) => s.force)) {
      const of = held.of ? renamed.get(held.of) : look;
      into.states.push({ name: `${look} ${held.name.toLowerCase()}`, selector: held.selector, force: held.force, of });
    }
    bySlug.delete(other);
  }
}

// Looks renamed, held states' "of" following.
for (const [slug, renames] of Object.entries(edits.looks ?? {})) {
  known(slug, "looks");
  const component = bySlug.get(slug);
  for (const [from, to] of Object.entries(renames)) {
    const state = component.states.find((s) => s.name === from);
    if (!state) fail(`looks: ${slug} has no look "${from}" (it has ${component.states.map((s) => s.name).join(", ")})`);
    state.name = to;
    for (const held of component.states) if (held.of === from) held.of = to;
  }
}

// Which components stay.
let slugs = [...bySlug.keys()];
if (edits.keep) {
  for (const slug of edits.keep) known(slug, "keep");
  slugs = edits.keep.filter((slug) => bySlug.has(slug));
}
for (const slug of edits.drop ?? []) slugs = slugs.filter((s) => s !== slug);

// Names, and slugs from them.
const components = slugs.map((slug) => {
  const component = bySlug.get(slug);
  const named = edits.name?.[slug];
  if (named) {
    const [name, ownSlug] = named.split("|");
    component.name = name.trim();
    component.slug = (ownSlug ?? slugOf(name)).trim();
  }
  component.stage = edits.stage?.[slug] ?? componentStage(component);
  return component;
});
for (const added of edits.add ?? []) {
  if (!added.slug || !added.name || !Array.isArray(added.states)) fail('add: each component needs "slug", "name" and "states"');
  components.push(added);
}
const seen = new Set();
for (const component of components) {
  if (seen.has(component.slug)) fail(`two components would be called "${component.slug}"; name one differently`);
  seen.add(component.slug);
  component.stage = edits.stage?.[component.slug] ?? componentStage(component);
  componentStage(component);
  const names = new Set();
  for (const state of component.states) {
    if (names.has(state.name)) fail(`${component.slug} has two looks called "${state.name}"`);
    names.add(state.name);
  }
}

let themes = null;
try { themes = JSON.parse(readFileSync(join(survey, "themes.json"), "utf8")); } catch {}
if (!DARK_MODE_IMPORT_ENABLED) themes = null; // Use the light draft while dark importing is paused.
if (themes) {
  if (Array.isArray(themes.light) && Array.isArray(themes.dark)) {
    const light = new Set(themes.light.map((token) => token.name));
    const dark = new Set(themes.dark.map((token) => token.name));
    const onlyLight = [...light].filter((name) => !dark.has(name));
    const onlyDark = [...dark].filter((name) => !light.has(name));
    if (onlyLight.length || onlyDark.length) fail(`the two surveys need stable token names; only light: ${onlyLight.join(", ") || "none"}; only dark: ${onlyDark.join(", ") || "none"}`);
  } else themes = null;
}
const plan = { ...(themes ? { themes } : { palette: draft.palette }), type: draft.type, components };
writeFileSync(join(run, "plan.json"), JSON.stringify(plan, null, 2) + "\n");
console.log(`plan: ${join(run, "plan.json")}, ${components.length} components`);
for (const c of components) console.log(`  ${c.slug} (${c.name}, ${c.stage}): ${c.states.map((s) => s.name).join(", ")}`);
