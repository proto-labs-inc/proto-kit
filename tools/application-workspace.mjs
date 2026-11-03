#!/usr/bin/env node
/** Customer prototype creation, approved for connected customer repositories.
 * The kit and cloud source checkouts are never switched by this command. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { callTool, readConfig } from "./mcp-call.mjs";
import { protoHome } from "./proto-home.mjs";

const ID = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const git = (source, ...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export async function createApplicationWorkspace({ codebase, slug, route, title, request, appRoot = "." }, dependencies = {}) {
  if (!ID.test(codebase) || !ID.test(slug) || !route?.startsWith("/") || route.startsWith("//") || !title?.trim() || !request?.trim()) {
    throw new Error("Supply a codebase, slug, application route, title and request.");
  }
  const home = dependencies.home ?? protoHome();
  const codebaseRecord = JSON.parse(readFileSync(join(home, codebase, "codebase.json"), "utf8"));
  if (codebaseRecord.codebase !== codebase || codebaseRecord.source?.kind !== "repository") throw new Error("This codebase is not connected to a local repository.");
  const source = realpathSync(codebaseRecord.source.path);
  git(source, "rev-parse", "--is-inside-work-tree");
  const resolvedAppRoot = realpathSync(resolve(source, appRoot));
  const relAppRoot = relative(source, resolvedAppRoot);
  if (isAbsolute(appRoot) || relAppRoot === ".." || relAppRoot.startsWith(`..${sep}`) || !existsSync(join(resolvedAppRoot, "package.json"))) {
    throw new Error("App root must be a package in the connected repository.");
  }
  const base = git(source, "rev-parse", "--verify", "refs/heads/main^{commit}");
  const branch = `proto/${codebase}/${slug}`;
  const directory = join(home, codebase, "application-prototypes", slug);
  const worktree = join(directory, "worktree");
  const recordPath = join(directory, "prototype.json");
  let record;
  if (existsSync(recordPath)) {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
    if (record.codebase !== codebase || record.slug !== slug || record.route !== route || record.request !== request || record.source !== source || record.branch !== branch || record.appRoot !== relAppRoot || !existsSync(worktree)) {
      throw new Error("Prototype workspace differs from this request; reconcile it before continuing.");
    }
    if (git(worktree, "branch", "--show-current") !== branch) throw new Error("Prototype worktree is on an unexpected branch.");
  } else {
    if (existsSync(worktree)) throw new Error("Worktree path is already occupied.");
    try { git(source, "show-ref", "--verify", `refs/heads/${branch}`); }
    catch { /* A new prototype must not reuse an existing branch. */ }
    if (git(source, "branch", "--list", branch)) throw new Error("Prototype branch already exists without a workspace record.");
    mkdirSync(directory, { recursive: true });
    execFileSync("git", ["-C", source, "worktree", "add", "-b", branch, worktree, base], { stdio: ["ignore", "pipe", "pipe"] });
    record = { schemaVersion: 1, codebase, slug, title: title.trim(), route, request, source, appRoot: relAppRoot, base, branch, worktree,
      alternateStorage: join(directory, "alternates"), createdAt: new Date().toISOString() };
    writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  const config = (dependencies.readConfig ?? readConfig)();
  const credential = config.credentials.find(item => item.team?.id === codebaseRecord.team?.id);
  if (!credential) throw new Error("This laptop is not linked to the codebase's team.");
  const call = dependencies.callTool ?? callTool;
  let result = await call("create_prototype", { codebase, slug, title: title.trim(), route, request }, { app: config.app, secret: credential.secret });
  if (result.isError) {
    const context = await call("get_prototype_context", { codebase, slug }, { app: config.app, secret: credential.secret });
    if (context.isError) throw new Error("The local worktree exists, but Proto registration failed. Retry this same command after resolving the cloud error.");
    const saved = JSON.parse(context.content[0].text).prototype;
    if (saved.application_route !== route || saved.application_request !== request) throw new Error("Proto has a different prototype at this slug.");
    result = context;
  }
  return { record, cloud: JSON.parse(result.content[0].text) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.slice(2);
    if (!args[i]?.startsWith("--") || !["codebase", "slug", "route", "title", "request", "app-root"].includes(key) || !args[i + 1] || values[key]) {
      throw new Error("Usage: application-workspace.mjs --codebase id --slug id --route /path --title name --request text [--app-root subdirectory]");
    }
    values[key] = args[i + 1];
  }
  try { console.log(JSON.stringify(await createApplicationWorkspace({ ...values, appRoot: values["app-root"] }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
