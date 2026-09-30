#!/usr/bin/env node
/**
 * Checks a workspace's component markers: every .tsx/.vue file that renders
 * components must carry data-proto-id markers, and ids must be kebab-case
 * (dot-separated kebab segments allowed — ids ported from a scope.component
 * convention stay verbatim, since ids are comment anchor keys).
 * The markers are what the Frame's comment mode hit-tests, so a missing
 * marker means a component nobody can comment on.
 *
 * Usage: node verify-markers.mjs <workspace-dir>
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const [target] = process.argv.slice(2);
if (!target) {
  console.error("usage: node verify-markers.mjs <workspace-dir>");
  process.exit(1);
}
const src = join(target, "src");

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".vue")) files.push(full);
  }
})(src);

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const ids = new Map(); // id -> files using it
let failed = false;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  const rel = relative(target, file);

  // Renderable component: a .vue SFC with a template block, or a .tsx file
  // exporting a capitalized function. main.tsx only mounts, it renders
  // nothing of its own.
  const rendersComponents = file.endsWith(".vue")
    ? /<template[\s>]/.test(source)
    : !file.endsWith("main.tsx") &&
      /export\s+(?:default\s+)?function\s+[A-Z]/.test(source);

  // Coverage counts every marker form — literal, JSX expression
  // (data-proto-id={…}), or bound (:data-proto-id="…"). Only literals
  // get their ids validated and inventoried.
  const markerCount = [...source.matchAll(/data-proto-id=/g)].length;
  // (?<!:) — a Vue-bound :data-proto-id="expr" is dynamic, not a literal id.
  const markers = [...source.matchAll(/(?<!:)\bdata-proto-id="([^"]*)"/g)].map((m) => m[1]);
  for (const id of markers) {
    if (!KEBAB.test(id)) {
      console.error(`${rel}: data-proto-id "${id}" is not kebab-case`);
      failed = true;
    }
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push(rel);
  }

  // A file that renders no element of its own (a switch that picks
  // another component, a hook file) has nothing to put a marker on.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rendersElements = /<[a-z][a-z0-9]*[\s/>]/.test(code);

  if (rendersComponents && rendersElements && markerCount === 0) {
    console.error(`${rel}: renders components but has no data-proto-id markers`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log(`${ids.size} marker id(s) across ${files.length} file(s):`);
for (const [id, where] of [...ids.entries()].sort()) {
  console.log(`  ${id}  (${[...new Set(where)].join(", ")})`);
}
