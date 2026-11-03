#!/usr/bin/env node
/** Immutable alternate bundles, kept beside the customer worktree in Proto storage. */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { callTool, readConfig } from "./mcp-call.mjs";
import { protoHome } from "./proto-home.mjs";
import { writeApplicationManifest } from "./application-manifest.mjs";
import { ensureAlternateDependencies } from "./application-package-manager.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const inside = (parent, child) => { const rel = relative(parent, child); return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel); };

export function bundleRevision(folder) {
  const root = realpathSync(folder);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Alternate bundles cannot contain symlinks.");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error("Alternate bundles contain an unsupported file.");
    }
  };
  walk(root);
  if (!files.some(file => /\.(tsx|jsx)$/.test(file))) throw new Error("An alternate bundle needs a React module.");
  const hash = createHash("sha256");
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.length > 1024 * 1024) throw new Error("Alternate file exceeds 1 MiB.");
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function context(codebase, slug, deps = {}) {
  const home = deps.home ?? protoHome();
  const record = JSON.parse(readFileSync(join(home, codebase, "application-prototypes", slug, "prototype.json"), "utf8"));
  if (record.codebase !== codebase || record.slug !== slug || !inside(join(home, codebase), record.alternateStorage)) throw new Error("Invalid application prototype record.");
  const codebaseRecord = JSON.parse(readFileSync(join(home, codebase, "codebase.json"), "utf8"));
  const config = (deps.readConfig ?? readConfig)();
  const credential = config.credentials.find(item => item.team?.id === codebaseRecord.team?.id);
  if (!credential) throw new Error("This laptop is not linked to the codebase's team.");
  return { record, target: { app: config.app, secret: credential.secret }, call: deps.callTool ?? callTool };
}

function unwrap(result) {
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "Proto rejected the alternate.");
  return JSON.parse(result.content[0].text);
}

export async function beginApplicationSet({ codebase, slug, targetKey, title }, deps) {
  const { target, call } = context(codebase, slug, deps);
  return unwrap(await call("begin_alternate_set", { codebase, slug, targetKey, title }, target));
}

export async function saveApplicationAlternate({ codebase, slug, setId, title, staging }, deps) {
  if (!UUID.test(setId) || !title?.trim()) throw new Error("Supply a set ID and title.");
  const { record, target, call } = context(codebase, slug, deps);
  ensureAlternateDependencies(record);
  const source = realpathSync(resolve(staging));
  if (!inside(realpathSync(record.alternateStorage), source) || !statSync(source).isDirectory()) throw new Error("Staging must be inside this prototype's alternate storage.");
  const revision = bundleRevision(source);
  const destination = join(record.alternateStorage, setId, revision);
  if (existsSync(destination)) {
    if (bundleRevision(destination) !== revision) throw new Error("Saved alternate revision was modified.");
  } else {
    mkdirSync(join(record.alternateStorage, setId), { recursive: true });
    const temporary = `${destination}.${process.pid}.tmp`;
    try {
      cpSync(source, temporary, { recursive: true, errorOnExist: true, force: false });
      if (bundleRevision(temporary) !== revision) throw new Error("Alternate changed while saving; retry from a stable staging bundle.");
      renameSync(temporary, destination);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  const version = unwrap(await call("save_alternate", { codebase, slug, setId, title, sourceRevision: revision }, target));
  writeFileSync(`${destination}.json`, `${JSON.stringify({ setId, versionId: version.id, sourceRevision: revision })}\n`);
  return { version, source: destination };
}

export async function finishApplicationSet({ codebase, slug, setId }, deps) {
  if (!UUID.test(setId)) throw new Error("Supply a set ID.");
  const { record, target, call } = context(codebase, slug, deps);
  unwrap(await call("finish_alternate_set", { codebase, slug, setId }, target));
  const state = unwrap(await call("get_prototype_context", { codebase, slug }, target));
  const previewPath = join(dirname(record.worktree), "preview.json");
  let port = 0;
  try { port = JSON.parse(readFileSync(previewPath, "utf8")).port; } catch { /* Preview has not started yet. */ }
  return writeApplicationManifest(record, target.app, port, state.sets);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, ...args] = process.argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !args[i + 1] || values[key]) throw new Error("Expected --name value pairs.");
    values[key] = args[i + 1];
  }
  try {
    if (action === "begin") console.log(JSON.stringify(await beginApplicationSet(values)));
    else if (action === "save") console.log(JSON.stringify(await saveApplicationAlternate(values)));
    else if (action === "finish") console.log(JSON.stringify(await finishApplicationSet(values)));
    else throw new Error("Usage: application-alternates.mjs begin|save|finish --codebase id --slug id ...");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
