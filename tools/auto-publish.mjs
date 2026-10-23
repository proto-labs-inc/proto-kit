#!/usr/bin/env node
/**
 * Publish every prototype and library the agent changed this turn, so the
 * copy everyone else sees follows the maker's within a turn. The maker sees
 * the local dev server in the Proto desktop app; nobody else reaches this
 * laptop, so the published copy is all they have.
 *
 * Runs at the end of each agent turn (tools/hooks/auto-publish-turn.mjs,
 * detached, so the agent never waits on it), not on every file save: a
 * turn's end is when the agent believes the work is in a good state.
 *
 * What the turn changed: tools/hooks/turn-start.mjs records when the
 * session's turn began (<home>/.turns/<session>.json), and a workspace with
 * a file modified since then was changed, whatever made the change (an
 * edit tool, a shell command, a patch, a tool the agent ran). A session
 * with no recorded turn start publishes nothing.
 *
 * A run is a run dir under <home>/<codebase>/run/<name>/, up or not:
 * building needs no dev server, so an edit made while the run is stopped
 * (after a laptop restart) is published all the same. "library" is the
 * library, any other name the prototype of that slug. Left alone, with a
 * line in <run>/publish.log:
 * - a run serving a starter's saved build (tools/serve.mjs), which has
 *   nothing to build until serve switches it to the dev server;
 * - a prototype whose build request (brief) is still open: create-prototype
 *   and the variant skills publish it themselves when they finish, and a
 *   half-built prototype must never reach anyone.
 *
 * The one check is the build: a build that fails publishes nothing, and
 * the last good copy stays. A publish that fails for a reason that may pass
 * (a build error, the network) leaves <run>/publish.retry, so the next turn
 * end tries again; one the app refuses (another team's prototype, a laptop
 * not linked to that team) is logged and not retried until it changes
 * again. <run>/published.fingerprint records what went out.
 *
 * A prototype's publish takes <run>/publish.lock, the same lock publish.mjs
 * waits for, so the skill's own publish and this one never build or upload
 * at once. A turn that ends while one is running leaves <run>/publish.pending
 * and returns, and the running one goes round again. The library goes
 * through publish-library.mjs --wait, which has its own lock.
 *
 * Usage: node auto-publish.mjs <session id>
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOfWorkspace } from "./build-folder.mjs";
import { callTool, readConfig, targetFor } from "./mcp-call.mjs";
import { protoHome } from "./proto-home.mjs";
import { readJson } from "./run-repair.mjs";
import { refreshRunLock, takeRunLock } from "./run-lock.mjs";
import { failPublishAttempt, readPublishStatus, startPublishAttempt } from "./publish-status.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STEP_TIMEOUT_MS = 10 * 60_000;
// What a build, an install or a publish writes into the workspace: never
// a change worth publishing.
const SKIPPED = new Set(["node_modules", "dist", ".git", ".proto", ".publish-lock", ".publish-pending"]);
// What the app answers when a publish can never succeed from this laptop
// as things stand: retrying at every turn end would only repeat it.
const REFUSED = /unknown prototype|unknown codebase|Only its creator|was deleted|not linked to|not set up|no longer works/i;

const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Where a session's turn start is kept. */
export function turnFile(home, session) {
  return SESSION_RE.test(String(session)) ? join(home, ".turns", `${session}.json`) : null;
}

/** The time the session's current turn began, in ms, or null. */
export function turnStart(home, session) {
  const file = turnFile(home, session);
  const at = file ? readJson(file)?.at : null;
  return Number.isFinite(at) ? at : null;
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIPPED.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory() ? walk(path, visit) : entry.isFile() && visit(path)) return true;
  }
  return false;
}

/** Whether any file under `dir` was written after `since` (ms). */
export function changedSince(dir, since) {
  return walk(dir, (path) => statSync(path).mtimeMs > since);
}

/** A fingerprint of the files under `dir`: changes when any file is
 *  added, removed, resized or rewritten. */
export function fingerprint(dir) {
  const hash = createHash("sha1");
  walk(dir, (path) => {
    const stat = statSync(path);
    hash.update(`${path.slice(dir.length)}\0${stat.size}\0${stat.mtimeMs}\n`);
    return false;
  });
  return hash.digest("hex");
}

/** Every run on this laptop with a workspace to build, and what it serves. */
export function runsOn(home) {
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
      const dev = readJson(join(runDir, "spec.json"))?.processes?.find((p) => p.name === "dev");
      if (!dev) continue;
      const kind = name === "library" ? "library" : "prototype";
      const workspace = kind === "library" ? join(home, codebase, "library") : join(home, codebase, "prototypes", name);
      if (!existsSync(join(workspace, "package.json"))) continue;
      const starter = Boolean(dev.command?.some((arg) => String(arg).endsWith("/serve.mjs")));
      runs.push({ kind, codebase, name, runDir, workspace, starter });
    }
  }
  return runs;
}

/** The workspace's own build command, from its lockfile. */
export function buildCommand(workspace) {
  if (existsSync(join(workspace, "package-lock.json"))) return ["npm", ["run", "build"]];
  if (existsSync(join(workspace, "yarn.lock"))) return ["yarn", ["build"]];
  return ["pnpm", ["build"]];
}

/** Whether the workspace's build request is still open (not done). An
 *  answer the app cannot give counts as open: publishing is the skill's then. */
async function openBrief(workspace) {
  const build = buildOfWorkspace(workspace);
  if (!build) return false;
  try {
    const response = await callTool("get_brief", { briefId: build.briefId }, targetFor(readConfig(), { codebase: build.codebase }));
    const text = response?.content?.[0]?.text ?? "{}";
    return response?.isError || JSON.parse(text).status !== "done";
  } catch {
    return true;
  }
}

function run(command, args, cwd, log) {
  const out = spawnSync(command, args, { cwd, encoding: "utf8", timeout: STEP_TIMEOUT_MS });
  const output = `${out.stdout ?? ""}${out.stderr ?? ""}`;
  appendFileSync(log, output);
  return { ok: out.status === 0, output };
}

/** What auto-publish runs, replaceable in tests. */
export const defaultSteps = {
  openBrief,
  build: (workspace, log) => run(...buildCommand(workspace), workspace, log),
  publishPrototype: (workspace, log, attemptId) =>
    run(process.execPath, [join(HERE, "publish.mjs"), "--kind", "prototype", workspace, "--auto", "--attempt-id", attemptId], workspace, log),
  publishLibrary: (workspace, log) =>
    run(process.execPath, [join(HERE, "publish-library.mjs"), workspace, "--wait"], workspace, log),
};

/** Publish one run that has something new; never throws. */
export async function publishRun(run, steps = defaultSteps) {
  const log = join(run.runDir, "publish.log");
  const note = (line) => appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
  const recorded = join(run.runDir, "published.fingerprint");
  const retry = join(run.runDir, "publish.retry");
  const changed = () => {
    const now = fingerprint(run.workspace);
    return existsSync(recorded) && readFileSync(recorded, "utf8") === now ? null : now;
  };
  // A publish that went out, one that may pass next time, or one the app refused.
  const settle = (result, now) => {
    if (result.ok) {
      writeFileSync(recorded, now);
      rmSync(retry, { force: true });
    } else if (REFUSED.test(result.output)) {
      rmSync(retry, { force: true });
      note("the app refused this publish; nothing is retried until the workspace changes again");
    } else {
      writeFileSync(retry, "");
      note("not published; the last published copy stays, and the next turn end tries again");
    }
  };

  if (run.starter) {
    note("this run serves a starter's saved build: switch it to the dev server (serve, step 2) for edits to publish");
    return;
  }
  if (run.kind === "prototype" && (await steps.openBrief(run.workspace))) {
    note("a build request is still open in this workspace; its skill publishes it when it finishes");
    return;
  }
  if (run.kind === "library") {
    const now = changed();
    if (!now) return;
    note("publishing the library");
    settle(steps.publishLibrary(run.workspace, log), now);
    return;
  }

  const lock = join(run.runDir, "publish.lock");
  const pending = join(run.runDir, "publish.pending");
  if (!takeRunLock(lock, { wait: false })) {
    mkdirSync(pending, { recursive: true });
    return;
  }
  try {
    do {
      rmSync(pending, { recursive: true, force: true });
      refreshRunLock(lock);
      const now = changed();
      if (!now) continue;
      note(`publishing ${run.codebase}/${run.name}`);
      const attempt = startPublishAttempt(run.workspace);
      try {
        const built = steps.build(run.workspace, log);
        if (!built.ok) {
          note("the build failed; nothing published");
          failPublishAttempt(run.workspace, attempt.attemptId, built.output || "The build failed; nothing was published");
          settle(built, now);
          continue;
        }
        refreshRunLock(lock);
        const result = steps.publishPrototype(run.workspace, log, attempt.attemptId);
        const status = readPublishStatus(run.workspace);
        // A child can publish successfully, then fail only while reporting
        // progress. Publication has already happened and must stay successful.
        if (status?.attemptId === attempt.attemptId && status.status === "published") {
          settle({ ok: true }, now);
        } else {
          if (!result.ok) failPublishAttempt(run.workspace, attempt.attemptId, result.output || "Publishing failed");
          settle(result, now);
        }
      } catch (error) {
        failPublishAttempt(run.workspace, attempt.attemptId, error);
        settle({ ok: false, output: error.message ?? String(error) }, now);
        note(error.message ?? String(error));
      }
    } while (existsSync(pending));
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Publish what the session's turn changed, plus anything left to retry. */
export async function publishTurn(home, session, steps = defaultSteps) {
  const since = turnStart(home, session);
  if (since === null) return [];
  const done = [];
  for (const run of runsOn(home)) {
    const touched = changedSince(run.workspace, since);
    if (!touched && !existsSync(join(run.runDir, "publish.retry"))) continue;
    try {
      await publishRun(run, steps);
    } catch (error) {
      try {
        appendFileSync(join(run.runDir, "publish.log"), `${new Date().toISOString()} ${error.message}\n`);
      } catch {}
    }
    done.push(run);
  }
  return done;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await publishTurn(protoHome(), process.argv[2]);
}
