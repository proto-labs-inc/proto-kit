#!/usr/bin/env node
/**
 * Publish every served prototype and library the agent edited this turn,
 * so the copy everyone else sees follows the maker's within a turn. The maker sees the local dev server in the Proto
 * desktop app; nobody else reaches this laptop, so the published copy is
 * all they have.
 *
 * Runs at the end of each agent turn (tools/hooks/auto-publish-turn.mjs,
 * detached, so the agent never waits on it), not on every file save: a
 * turn's end is when the agent believes the work is in a good state. The
 * one check is the build: a build that fails publishes nothing, and the
 * last good copy stays. What the agent edited is what the after-edit hook
 * (tools/hooks/post-edit-markers.mjs) asked for: <run>/publish.requested,
 * taken here as the publish starts. A served run is a run dir under
 * <home>/<codebase>/run/<name>/ whose supervisor is up; "library" is the
 * library, any other name the prototype of that slug. A run serving an
 * unchanged starter's saved build (tools/serve.mjs) has nothing to build.
 *
 * Changed means a different fingerprint of the workspace's files (path,
 * size and modification time, leaving out what a build or install
 * writes), kept in <run>/published.fingerprint after each publish that
 * went out. Each run logs to <run>/publish.log.
 *
 * A prototype's publish takes <run>/publish.lock the way
 * publish-library.mjs takes the library's: a turn that ends while one
 * is running leaves <run>/publish.pending and returns, and the running
 * one goes round again. The library uses publish-library.mjs itself.
 *
 * Usage: node auto-publish.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { protoHome } from "./proto-home.mjs";
import { alive, readJson } from "./run-repair.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STALE_MS = 20 * 60_000;
// What a build, an install or a publish writes into the workspace: never
// a change worth publishing.
const SKIPPED = new Set(["node_modules", "dist", ".git", ".publish-lock", ".publish-pending"]);

/** A fingerprint of the files under `dir`: changes when any file is
 *  added, removed, resized or rewritten. */
export function fingerprint(dir) {
  const hash = createHash("sha1");
  (function walk(folder) {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIPPED.has(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        const stat = statSync(path);
        hash.update(`${path.slice(dir.length)}\0${stat.size}\0${stat.mtimeMs}\n`);
      }
    }
  })(dir);
  return hash.digest("hex");
}

/** Every run whose supervisor is up, with what it serves, and whether a
 *  publish was requested for it. */
export function servedRuns(home = protoHome()) {
  const runs = [];
  const dirs = (path) => {
    try {
      return readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  };
  for (const codebase of dirs(home)) {
    for (const name of dirs(join(home, codebase, "run"))) {
      const runDir = join(home, codebase, "run", name);
      const spec = readJson(join(runDir, "spec.json"));
      const state = readJson(join(runDir, "state.json"));
      const dev = spec?.processes?.find((p) => p.name === "dev");
      if (!dev || state === null || !alive(state.pid)) continue;
      if (dev.command?.some((arg) => String(arg).endsWith("/serve.mjs"))) continue;
      const kind = name === "library" ? "library" : "prototype";
      const workspace = kind === "library" ? join(home, codebase, "library") : join(home, codebase, "prototypes", name);
      if (existsSync(join(workspace, "package.json"))) {
        runs.push({ kind, codebase, name, runDir, workspace, requested: existsSync(join(runDir, "publish.requested")) });
      }
    }
  }
  return runs;
}

function publishRun(run) {
  rmSync(join(run.runDir, "publish.requested"), { force: true });
  const log = join(run.runDir, "publish.log");
  const note = (line) => appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
  const recorded = join(run.runDir, "published.fingerprint");
  const changed = () => {
    const now = fingerprint(run.workspace);
    return existsSync(recorded) && readFileSync(recorded, "utf8") === now ? null : now;
  };
  const sh = (command, args, cwd) => {
    const out = spawnSync(command, args, { cwd, encoding: "utf8" });
    appendFileSync(log, `${out.stdout ?? ""}${out.stderr ?? ""}`);
    return out.status === 0;
  };

  if (run.kind === "library") {
    const now = changed();
    if (!now) return;
    note("publishing the library");
    if (sh(process.execPath, [join(HERE, "publish-library.mjs"), run.workspace], run.workspace)) writeFileSync(recorded, now);
    else note("not published; the last published copy stays");
    return;
  }

  const lock = join(run.runDir, "publish.lock");
  const pending = join(run.runDir, "publish.pending");
  try {
    mkdirSync(lock);
  } catch {
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {}
    if (age <= STALE_MS) {
      mkdirSync(pending, { recursive: true });
      return;
    }
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  try {
    do {
      rmSync(pending, { recursive: true, force: true });
      const now = changed();
      if (!now) continue;
      note(`publishing ${run.codebase}/${run.name}`);
      if (!sh("pnpm", ["build"], run.workspace)) {
        note("the build failed; nothing published, the last published copy stays");
        continue;
      }
      if (sh(process.execPath, [join(HERE, "publish.mjs"), "--kind", "prototype", run.workspace, "--auto"], run.workspace)) writeFileSync(recorded, now);
      else note("not published; the last published copy stays");
    } while (existsSync(pending));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const run of servedRuns().filter((run) => run.requested)) {
    try {
      publishRun(run);
    } catch (error) {
      try {
        appendFileSync(join(run.runDir, "publish.log"), `${new Date().toISOString()} ${error.message}\n`);
      } catch {}
    }
  }
}
