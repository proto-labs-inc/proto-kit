#!/usr/bin/env node
// Older React workspaces ignore image watcher events but only serve previews
// and wireframes directly. New reference files otherwise fall through to HTML.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function repairReferenceServing(workspace) {
  const file = join(workspace, "vite.config.ts");
  if (!existsSync(file)) return { changed: false, file };
  const source = readFileSync(file, "utf8");
  const old = String.raw`const PUBLISHED = /^\/(?:previews|wireframes)\//;`;
  const updated = String.raw`const PUBLISHED = /^\/(?:previews|wireframes|references)\//;`;
  // Only migrate the kit's known legacy middleware; preserve custom configs.
  if (!source.includes('name: "proto-public-assets"') || !source.includes(old))
    return { changed: false, file };
  writeFileSync(file, source.replace(old, updated));
  return { changed: true, file };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) {
    console.error("usage: repair-reference-serving.mjs <workspace>");
    process.exit(1);
  }
  console.log(JSON.stringify(repairReferenceServing(resolve(process.argv[2]))));
}
