import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The app serves this small, recorded bridge contract at /prototype.json.
 * Alternate implementation modules stay outside the checkout. */
export function writeApplicationManifest(record, appOrigin, port, rows = null) {
  const path = join(resolve(record.worktree, record.appRoot), "public", "prototype.json");
  let previous = null;
  if (existsSync(path)) {
    previous = JSON.parse(readFileSync(path, "utf8"));
    if (previous.protoApplication !== true || previous.name !== record.slug) throw new Error("The app already has an unrelated public/prototype.json.");
  }
  const sets = new Map();
  for (const row of rows ?? []) {
    let set = sets.get(row.id);
    if (!set) {
      set = { id: row.id, component: row.id, title: row.title, default: "original", baseline: "original", regions: [row.id], variants: [{ id: "original", title: "Original" }] };
      sets.set(row.id, set);
    }
    if (row.version_id) set.variants.push({ id: row.version_id, title: row.version_title });
  }
  const manifest = { schemaVersion: 2, protoApplication: true, name: record.slug, port, needsServer: true,
    frameOrigin: new URL(appOrigin).origin, states: [], variantSets: rows === null ? previous?.variantSets ?? [] : [...sets.values()] };
  mkdirSync(join(resolve(record.worktree, record.appRoot), "public"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path, manifest };
}
