#!/usr/bin/env node
/** Start the customer's own dev script for an application prototype route. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { protoHome } from "./proto-home.mjs";
import { readConfig } from "./mcp-call.mjs";
import { releasePort, reservePort } from "./ports.mjs";
import { writeApplicationManifest } from "./application-manifest.mjs";
import { applicationPackageManager, ensureAlternateDependencies, installApplicationDependencies } from "./application-package-manager.mjs";
import { restoreApplicationAlternates } from "./application-alternates.mjs";

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const answering = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

export async function ensureApplicationPreview({ codebase, slug }, deps = {}) {
  const home = deps.home ?? protoHome();
  const directory = join(home, codebase, "application-prototypes", slug);
  const record = JSON.parse(readFileSync(join(directory, "prototype.json"), "utf8"));
  if (record.codebase !== codebase || record.slug !== slug || record.worktree !== join(directory, "worktree") || !record.route || record.appRoot == null) throw new Error("Invalid application prototype record.");
  const app = realpathSync(resolve(record.worktree, record.appRoot));
  const appRelative = relative(realpathSync(record.worktree), app);
  if (isAbsolute(record.appRoot) || appRelative === ".." || appRelative.startsWith(`..${sep}`)) throw new Error("Application package escapes its worktree.");
  if (!existsSync(join(app, "package.json"))) throw new Error("The customer's application package is missing from its prototype worktree.");
  installApplicationDependencies(record.worktree, app);
  ensureAlternateDependencies(record);
  await restoreApplicationAlternates({ codebase, slug }, deps);
  const manager = applicationPackageManager(record.worktree);
  const statePath = join(directory, "preview.json");
  const owner = statePath;
  let state = null;
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* First start. */ }
  let port = state?.port;
  const config = (deps.readConfig ?? readConfig)();
  const routeUrl = (value) => new URL(record.route, `http://localhost:${value}`).href;
  if (!state?.pid || !alive(state.pid) || !await answering(routeUrl(port))) {
    await releasePort(owner);
    port = await reservePort({ owner, from: 5200, to: 5400 });
    writeApplicationManifest(record, config.app, port);
    mkdirSync(directory, { recursive: true });
    const log = openSync(join(directory, "preview.log"), "a");
    const child = spawn(manager.bin, manager.dev(port), { cwd: app, stdio: ["ignore", log, log], detached: true });
    let startError = null;
    child.once("error", error => { startError = error; });
    child.unref();
    const until = Date.now() + 45_000;
    while (Date.now() < until && !await answering(routeUrl(port))) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error("Application dev server exited. Read preview.log in the prototype folder.");
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (!await answering(routeUrl(port))) throw new Error("Application route did not start. Read preview.log in the prototype folder.");
    state = { port, pid: child.pid, route: record.route, startedAt: new Date().toISOString() };
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
  const frame = new URL(`/p/${encodeURIComponent(slug)}`, config.app);
  frame.searchParams.set("origin", routeUrl(port));
  frame.searchParams.set("codebase", codebase);
  return { applicationUrl: routeUrl(port), frameUrl: frame.href, port, pid: state.pid };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [codebase, slug] = process.argv.slice(2);
  try { console.log(JSON.stringify(await ensureApplicationPreview({ codebase, slug }))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
