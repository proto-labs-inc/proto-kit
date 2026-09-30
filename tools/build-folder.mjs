/**
 * Where a prototype's build folder is, from either end: the brief id
 * names ~/.proto/<codebase>/run/builds/<briefId>/, and a workspace path
 * (~/.proto/<codebase>/prototypes/<slug>/) finds the build whose
 * workspace.json points at it. The build folder holds the read of the
 * reference page (tree.json with its curation, read.json) that the
 * checks compare the prototype against.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const protoHome = () => join(process.env.HOME ?? "", ".proto");

export const buildFolder = (codebase, briefId) => join(protoHome(), codebase, "run", "builds", briefId);

/** The codebase id a workspace path belongs to, or null when it is not under ~/.proto. */
export function codebaseOfWorkspace(workspace) {
  const match = /[\\/]\.proto[\\/]([^\\/]+)[\\/]prototypes[\\/]/.exec(resolve(workspace) + "/");
  return match ? match[1] : null;
}

/**
 * The build that scaffolded a workspace: { codebase, briefId, dir, tree,
 * curation, read() } or null when no build folder names it. `read()`
 * parses read.json on demand, since it is large.
 */
export function buildOfWorkspace(workspace) {
  const codebase = codebaseOfWorkspace(workspace);
  if (!codebase) return null;
  const builds = join(protoHome(), codebase, "run", "builds");
  if (!existsSync(builds)) return null;
  const target = resolve(workspace);
  for (const briefId of readdirSync(builds)) {
    const dir = join(builds, briefId);
    const record = join(dir, "workspace.json");
    if (!existsSync(record)) continue;
    let path;
    try {
      path = JSON.parse(readFileSync(record, "utf8")).path;
    } catch {
      continue;
    }
    if (resolve(path) !== target) continue;
    const treePath = join(dir, "tree.json");
    const tree = existsSync(treePath) ? JSON.parse(readFileSync(treePath, "utf8")) : null;
    return {
      codebase,
      briefId,
      dir,
      tree,
      curation: tree?.curation ?? null,
      read: () => JSON.parse(readFileSync(join(dir, "read.json"), "utf8")),
    };
  }
  return null;
}

/** The rect the read found for each marker, from a build's curation: marker -> { x, y, w, h }, and marker -> node id. */
export function markerRects(build) {
  const rects = new Map();
  const nodeIds = new Map();
  if (!build?.tree || !build.curation) return { rects, nodeIds };
  const nodes = new Map(build.tree.nodes.map((node) => [node.id, node]));
  for (const entry of build.curation) {
    if (!entry.marker || rects.has(entry.marker)) continue;
    const node = nodes.get(entry.id);
    if (!node) continue;
    rects.set(entry.marker, node.rect);
    nodeIds.set(entry.marker, entry.id);
  }
  return { rects, nodeIds };
}

/**
 * The next pass number for a node in a build, across the tools that
 * check it after the copy (check-states, check-part): the site counts
 * passes per node, so each is one more than the last.
 */
export function nextPassFor(buildDir, nodeId) {
  const path = join(buildDir, "passes.json");
  const passes = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  passes[nodeId] = (passes[nodeId] ?? 0) + 1;
  writeFileSync(path, JSON.stringify(passes, null, 2) + "\n");
  return passes[nodeId];
}
