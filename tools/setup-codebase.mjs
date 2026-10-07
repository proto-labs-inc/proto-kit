#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { callTool, readConfig } from "./mcp-call.mjs";

export function atomicRecord(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function setupCodebase(options, deps = {}) {
  const home = deps.home ?? join(process.env.HOME ?? "", ".proto");
  const save = deps.save ?? atomicRecord;
  const call = deps.call ?? callTool;
  const config = (deps.config ?? readConfig)();
  const id = options.codebase;
  if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("Invalid codebase ID.");
  let previous = null;
  if (id) {
    const path = join(home, id, "codebase.json");
    if (existsSync(path)) {
      try { previous = JSON.parse(readFileSync(path, "utf8")); }
      catch { throw new Error("The local codebase record is unreadable; repair it before continuing."); }
      if (previous.codebase !== id) throw new Error("The local record names a different codebase.");
    }
  }
  if (options.team && previous?.team?.id && options.team !== previous.team.id) throw new Error("The supplied team does not own this local codebase.");
  const teamId = options.team ?? previous?.team?.id;
  const credentials = config.credentials.filter((credential) => !teamId || credential.team?.id === teamId);
  if (credentials.length !== 1) throw new Error("Choose a linked team with --team <team-id> before setting up this codebase.");
  const credential = credentials[0];
  if (!credential.team?.id) throw new Error("Link this laptop to a team before setting up a codebase.");
  if (options["live-url"]) {
    const url = new URL(options["live-url"]);
    if (!["https:", "http:"].includes(url.protocol)) throw new Error("The product URL must use HTTP or HTTPS.");
  }
  const directoryExists = (path) => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  };
  const reusable = previous?.team?.id && previous.source?.remote && directoryExists(previous.source?.path);
  if (reusable) {
    if (options.source && realpathSync(resolve(options.source)) !== realpathSync(previous.source.path)) throw new Error("This codebase already has a source folder; use its recorded folder.");
    if (options.remote && options.remote !== previous.source.remote) throw new Error("This codebase already has a different recorded remote.");
    if (options["live-url"] && options["live-url"] !== previous.source.liveUrl) {
      previous.source.liveUrl = options["live-url"];
      save(join(home, id, "codebase.json"), previous);
    }
    return { outcome: "reused", codebase: id, record: previous };
  }
  if (!options.source || !directoryExists(resolve(options.source))) throw new Error("Supply the confirmed source folder with --source <folder>.");
  const sourcePath = realpathSync(resolve(options.source));
  let remote = options.remote;
  if (!remote) {
    try { remote = execFileSync("git", ["-C", sourcePath, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { throw new Error("The source has no Git origin; supply its remote with --remote <url>."); }
  }
  if (!remote.trim()) throw new Error("The source remote cannot be empty.");
  let result;
  try {
    result = await call("set_codebase_source", { ...(id ? { codebase: id } : {}), sourcePath, repoRemote: remote }, { app: config.app, secret: credential.secret });
  } catch {
    if (!id) throw new Error("Codebase creation could not be confirmed. Check Proto for the created codebase and resume with --codebase <id>; do not retry creation blindly.");
    throw new Error("Proto could not record the source. Retry with the same codebase ID.");
  }
  if (result?.isError) throw new Error("Proto refused the source registration. Check the codebase and linked team before retrying.");
  let row;
  try { row = JSON.parse(result.content[0].text); } catch { throw new Error("Proto returned an unreadable registration result. Reconcile the codebase in Proto before retrying."); }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(row.codebase ?? "") || (id && id !== row.codebase) || row.team_id !== credential.team.id || !row.name) throw new Error("Proto returned an unexpected codebase or team. Reconcile the registration before retrying.");
  const record = {
    ...previous, schemaVersion: 1, codebase: row.codebase, name: row.name, team: credential.team,
    source: { ...previous?.source, path: sourcePath, remote, ...(options["live-url"] ? { liveUrl: options["live-url"] } : {}) },
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  try { save(join(home, row.codebase, "codebase.json"), record); }
  catch { throw new Error(`Proto recorded codebase ${row.codebase}, but its local record could not be saved. Resume with --codebase ${row.codebase} and the same source folder.`); }
  return { outcome: id ? "recovered" : "created", codebase: row.codebase, record };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith("--") || !["codebase", "source", "remote", "team", "live-url"].includes(key) || !args[i + 1] || args[i + 1].startsWith("--") || options[key]) throw new Error("Usage: setup-codebase.mjs [--codebase id] [--source folder] [--remote url] [--team id] [--live-url url]");
      options[key] = args[i + 1];
    }
    console.log(JSON.stringify(await setupCodebase(options)));
  } catch (error) {
    console.log(JSON.stringify({ outcome: "failed", message: error.message }));
    console.error(error.message);
    process.exitCode = 1;
  }
}
