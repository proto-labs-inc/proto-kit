#!/usr/bin/env node
/** Guard the selected implementation while an agent prepares an ordinary PR. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeApplicationAlternate } from "./application-alternates.mjs";
import { callTool, readConfig } from "./mcp-call.mjs";
import { protoHome } from "./proto-home.mjs";
import { applicationPackageManager } from "./application-package-manager.mjs";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const inside = (parent, child) => { const rel = relative(parent, child); return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

function local(codebase, slug, deps = {}) {
  const home = deps.home ?? protoHome();
  const directory = join(home, codebase, "application-prototypes", slug);
  const record = JSON.parse(readFileSync(join(directory, "prototype.json"), "utf8"));
  if (record.codebase !== codebase || record.slug !== slug || record.worktree !== join(directory, "worktree") || git(record.worktree, "branch", "--show-current") !== record.branch) {
    throw new Error("Application prototype record or worktree branch does not match.");
  }
  const codebaseRecord = JSON.parse(readFileSync(join(home, codebase, "codebase.json"), "utf8"));
  const config = (deps.readConfig ?? readConfig)();
  const credential = config.credentials.find(item => item.team?.id === codebaseRecord.team?.id);
  if (!credential) throw new Error("This laptop is not linked to the codebase's team.");
  return { record, directory, target: { app: config.app, secret: credential.secret }, call: deps.callTool ?? callTool };
}

async function cloud(codebase, slug, context) {
  const result = await context.call("get_prototype_context", { codebase, slug }, context.target);
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "Could not read shared selection.");
  return JSON.parse(result.content[0].text);
}

async function selectedBundles(context, state, codebase, slug, deps) {
  const choices = Object.entries(state.prototype.selected_alternates);
  const selected = [];
  for (const [setId, versionId] of choices) {
    const version = state.sets.find(row => row.id === setId && row.version_id === versionId);
    if (!version) throw new Error(`Selected alternate ${versionId} is no longer in set ${setId}.`);
    const { source, sourceRevision } = await materializeApplicationAlternate({ codebase, slug, setId, versionId }, deps);
    if (sourceRevision !== version.source_revision) throw new Error(`Alternate ${versionId} changed during preparation.`);
    selected.push({ setId, versionId, targetKey: version.target_key, sourceRevision, source });
  }
  return selected;
}

/** Read the exact shared choice before product edits. The agent uses the
 * returned bundles to apply ordinary product code. No commit or push occurs. */
export async function prepareSelectedForPr({ codebase, slug, wiringPaths }, deps = {}) {
  const context = local(codebase, slug, deps);
  const snapshotPath = join(context.directory, "pr-preparation.json");
  if (existsSync(snapshotPath)) throw new Error("PR preparation is already active. Verify or resume it before starting again.");
  const state = await cloud(codebase, slug, context);
  const selected = await selectedBundles(context, state, codebase, slug, deps);
  const paths = [...new Set(wiringPaths ?? [])];
  if (paths.length === 0) throw new Error("Record the exact preview wiring paths before preparing a PR.");
  for (const path of paths) {
    const full = resolve(context.record.worktree, path);
    if (!inside(context.record.worktree, full) || path.startsWith("-")) throw new Error("Wiring path must be inside the prototype worktree.");
    try { git(context.record.worktree, "ls-files", "--error-unmatch", "--", path); }
    catch { throw new Error(`Stage new wiring file ${path} before preparation so its patch can be restored.`); }
  }
  const patch = execFileSync("git", ["-C", context.record.worktree, "diff", "--binary", "HEAD", "--", ...paths], { encoding: "utf8" });
  if (!patch.trim()) throw new Error("Recorded paths contain no preview wiring diff to restore later.");
  const patchPath = join(context.directory, "preview-wiring.patch");
  writeFileSync(patchPath, patch, { mode: 0o600 });
  const snapshot = { selectionRevision: state.prototype.selection_revision, selected, wiringPaths: paths, patchPath,
    head: git(context.record.worktree, "rev-parse", "HEAD"), createdAt: new Date().toISOString() };
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { ...snapshot, next: "Apply only the selected bundles to ordinary product code. Remove preview wiring from submitted changes, then run verify_pr_ready before commit or push." };
}

export async function verifyPrReady({ codebase, slug }, deps = {}) {
  const context = local(codebase, slug, deps);
  const snapshot = JSON.parse(readFileSync(join(context.directory, "pr-preparation.json"), "utf8"));
  const state = await cloud(codebase, slug, context);
  const current = await selectedBundles(context, state, codebase, slug, deps);
  if (state.prototype.selection_revision !== snapshot.selectionRevision || JSON.stringify(current) !== JSON.stringify(snapshot.selected)) {
    throw new Error("Shared selection or alternate source changed during PR preparation. Reconcile choices before continuing.");
  }
  const diff = git(context.record.worktree, "diff", "--unified=0", "HEAD");
  const added = diff.split("\n").filter(line => line.startsWith("+") && !line.startsWith("+++"));
  if (added.some(line => /@proto-labs-inc\/rig|ProtoAlternateBoundary|data-proto-id|proto-version\.json/.test(line))) {
    throw new Error("Submitted changes still contain Proto preview wiring.");
  }
  const untracked = git(context.record.worktree, "ls-files", "--others", "--exclude-standard");
  if (untracked.split("\n").some(path => /proto|prototype\.json/i.test(path))) throw new Error("Untracked Proto preview files remain in the worktree.");
  const app = resolve(context.record.worktree, context.record.appRoot);
  const run = deps.build ?? ((cwd) => {
    const manager = applicationPackageManager(context.record.worktree);
    execFileSync(manager.bin, manager.build, { cwd, stdio: "inherit" });
  });
  await run(app);
  const latest = await cloud(codebase, slug, context);
  if (latest.prototype.selection_revision !== snapshot.selectionRevision || JSON.stringify(await selectedBundles(context, latest, codebase, slug, deps)) !== JSON.stringify(snapshot.selected)) {
    throw new Error("Shared selection changed during the build. Reconcile before committing or pushing.");
  }
  return { ready: true, selected: current, head: snapshot.head, build: "passed" };
}

/** After product changes are committed or the PR work is otherwise settled,
 * reapply the recorded boundary patch against current product code. Conflicts
 * stay for the agent to resolve; old alternate IDs and originals stay saved. */
export function resumePrototype({ codebase, slug }, deps = {}) {
  const context = local(codebase, slug, deps);
  const snapshotPath = join(context.directory, "pr-preparation.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  try { execFileSync("git", ["-C", context.record.worktree, "apply", "--3way", snapshot.patchPath], { stdio: ["ignore", "pipe", "pipe"] }); }
  catch { throw new Error("Preview wiring conflicts with current product code. Reconcile the recorded patch before resuming exploration."); }
  rmSync(snapshotPath);
  return { resumed: true, wiringPaths: snapshot.wiringPaths, selected: snapshot.selected };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, codebase, slug, ...paths] = process.argv.slice(2);
  try {
    let result;
    if (action === "prepare_selected_for_pr") result = await prepareSelectedForPr({ codebase, slug, wiringPaths: paths });
    else if (action === "verify_pr_ready") result = await verifyPrReady({ codebase, slug });
    else if (action === "resume_prototype") result = resumePrototype({ codebase, slug });
    else throw new Error("Usage: application-pr.mjs prepare_selected_for_pr|verify_pr_ready|resume_prototype <codebase> <slug> [wiring paths]");
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
