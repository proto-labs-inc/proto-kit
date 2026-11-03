#!/usr/bin/env node
/** Immutable alternate bundles. The cloud database is authoritative; this
 * folder beside the worktree is a disposable build cache. */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { callTool, readConfig } from "./mcp-call.mjs";
import { protoHome } from "./proto-home.mjs";
import { writeApplicationManifest } from "./application-manifest.mjs";
import { ensureAlternateDependencies } from "./application-package-manager.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REVISION = /^[a-f0-9]{64}$/;
const inside = (parent, child) => { const rel = relative(parent, child); return rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel); };

export function bundleFiles(folder) {
  const root = realpathSync(folder);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Alternate bundles cannot contain symlinks.");
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.push({ path: relative(root, path).split(sep).join("/"), base64: readFileSync(path).toString("base64") });
      else throw new Error("Alternate bundles contain an unsupported file.");
    }
  };
  walk(root);
  return files;
}

export function revisionOfFiles(files) {
  if (files.length === 0 || files.length > 64) throw new Error("Alternate bundle must contain 1 to 64 files.");
  const ordered = [...files].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
  const hash = createHash("sha256");
  const seen = new Set();
  let total = 0;
  let hasModule = false;
  for (const file of files) {
    if (!file.path || file.path.length > 500 || file.path.includes("\\") ||
      file.path.split("/").some(part => !part || part === "." || part === "..") || seen.has(file.path) ||
      !/^[A-Za-z0-9._/@+-]+$/.test(file.path)) throw new Error("Alternate bundle contains an unsafe or duplicate path.");
    seen.add(file.path);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error("Alternate bundle contains invalid base64.");
    const bytes = Buffer.from(file.base64, "base64");
    if (bytes.length > 1024 * 1024) throw new Error("Alternate file exceeds 1 MiB.");
    total += bytes.length;
    if (total > 8 * 1024 * 1024) throw new Error("Alternate bundle exceeds 8 MiB.");
    if (/\.(tsx|jsx)$/.test(file.path)) hasModule = true;
  }
  if (!hasModule) throw new Error("Alternate bundle needs a React module.");
  for (const file of ordered) {
    const bytes = Buffer.from(file.base64, "base64");
    hash.update(file.path);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function bundleRevision(folder) { return revisionOfFiles(bundleFiles(folder)); }

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
  const bundle = bundleFiles(source);
  const revision = revisionOfFiles(bundle);
  const version = unwrap(await call("save_alternate", { codebase, slug, setId, title, sourceRevision: revision, bundle }, target));
  const restored = await materializeApplicationAlternate({ codebase, slug, setId, versionId: version.id }, deps);
  if (restored.sourceRevision !== revision) throw new Error("Saved alternate source does not match the upload.");
  return { version, source: restored.source };
}

/** Rebuild one disposable source cache from the database. Never trust a local
 * directory merely because its name is a revision hash. */
export async function materializeApplicationAlternate({ codebase, slug, setId, versionId }, deps) {
  if (!UUID.test(setId) || !UUID.test(versionId)) throw new Error("Supply a set ID and version ID.");
  const { record, target, call } = context(codebase, slug, deps);
  ensureAlternateDependencies(record);
  const stored = unwrap(await call("get_alternate_source", { codebase, slug, setId, versionId }, target));
  if (stored.id !== versionId || stored.set_id !== setId || !REVISION.test(stored.source_revision) ||
    revisionOfFiles(stored.bundle) !== stored.source_revision) throw new Error("Stored alternate source is corrupt.");
  const destination = join(record.alternateStorage, setId, stored.source_revision);
  if (existsSync(destination)) {
    try { if (bundleRevision(destination) === stored.source_revision) return { source: destination, sourceRevision: stored.source_revision }; }
    catch { /* A cache can be rebuilt from its database row. */ }
    rmSync(destination, { recursive: true, force: true });
  }
  mkdirSync(join(record.alternateStorage, setId), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    mkdirSync(temporary, { recursive: true });
    for (const file of stored.bundle) {
      const path = join(temporary, ...file.path.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(file.base64, "base64"));
    }
    if (bundleRevision(temporary) !== stored.source_revision) throw new Error("Downloaded alternate source failed verification.");
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  writeFileSync(`${destination}.json`, `${JSON.stringify({ setId, versionId, sourceRevision: stored.source_revision })}\n`);
  return { source: destination, sourceRevision: stored.source_revision };
}

export async function restoreApplicationAlternates({ codebase, slug }, deps) {
  const { target, call } = context(codebase, slug, deps);
  const state = unwrap(await call("get_prototype_context", { codebase, slug }, target));
  const restored = [];
  for (const row of state.sets) {
    if (!row.version_id) continue;
    restored.push(await materializeApplicationAlternate({ codebase, slug, setId: row.id, versionId: row.version_id }, deps));
  }
  return restored;
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
    else if (action === "restore") console.log(JSON.stringify(await restoreApplicationAlternates(values)));
    else throw new Error("Usage: application-alternates.mjs begin|save|finish|restore --codebase id --slug id ...");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
