#!/usr/bin/env node
/**
 * Build the library app and publish it, in one call, serialised
 * (docs/library-contract.md, "The choreography"). The import runs this
 * after every component lands and again at the finish, so the
 * published library is never more than one component behind the one
 * the user is watching.
 *
 * Two units landing at the same moment would otherwise run two builds
 * into the same dist/, so this takes a publish lock of its own
 * (<library>/.publish-lock, outside public/ so it never reaches a
 * build) and waits for it. A publish that waits builds afterwards, so
 * it carries everything on disk by then, including whatever landed
 * while it waited. The writer's own lock is untouched: a unit's
 * history and status lines stay instant while a build runs.
 *
 * Usage: node publish-library.mjs <library> [--dry-run]
 *   <library> is the library app's folder (~/.proto/<codebase>/library)
 *   or just the codebase id, the same argument library.mjs takes. The
 *   codebase comes from public/manifest.json. --dry-run builds and
 *   prints the upload plan without touching the cloud.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// A build and an upload take tens of seconds, so a waiting publish
// waits minutes, and only a lock older than the longest plausible
// publish belongs to a process that died holding it.
const WAIT_MS = 10 * 60_000;
const STALE_MS = 20 * 60_000;

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const argument = args.find((a) => !a.startsWith("--"));
if (!argument) fail("usage: node publish-library.mjs <library> [--dry-run]");

let libraryDir = resolve(argument);
if (!argument.includes("/")) {
  const byId = join(process.env.HOME ?? "", ".proto", argument, "library");
  if (existsSync(byId)) libraryDir = byId;
}
if (!existsSync(join(libraryDir, "package.json"))) {
  fail(`${libraryDir} is not a library app (no package.json); scaffold it first (tools/host-library.mjs)`);
}
const manifestPath = join(libraryDir, "public", "manifest.json");
if (!existsSync(manifestPath)) fail(`${manifestPath} does not exist; run an import before publishing`);
const codebase = JSON.parse(readFileSync(manifestPath, "utf8")).codebase;
if (!codebase) fail(`${manifestPath} names no codebase; a library with nothing imported has nothing to publish`);

// mkdir is atomic: whoever makes the folder holds the lock.
const lock = join(libraryDir, ".publish-lock");
const deadline = Date.now() + WAIT_MS;
let waited = false;
for (;;) {
  try {
    mkdirSync(lock);
    break;
  } catch {
    let age = 0;
    try {
      age = Date.now() - statSync(lock).mtimeMs;
    } catch {}
    if (age > STALE_MS) {
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) fail(`${lock} is held by another publish; remove it if nothing is running`);
    if (!waited) {
      console.error("… another publish is running; this one builds after it, so it carries everything landed by then");
      waited = true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

// Release on every exit: fail() and a failed publish both call
// process.exit, which skips a finally block and would leave the lock
// holding every later publish for STALE_MS.
process.on("exit", () => rmSync(lock, { recursive: true, force: true }));

const build = spawnSync("pnpm", ["build"], { cwd: libraryDir, stdio: ["ignore", "inherit", "inherit"] });
if (build.status !== 0) fail(`pnpm build failed in ${libraryDir}`);
const publishArgs = [join(HERE, "publish.mjs"), "--kind", "library", "--codebase", codebase, "--dir", join(libraryDir, "dist")];
if (dryRun) publishArgs.push("--dry-run");
const publish = spawnSync(process.execPath, publishArgs, { stdio: ["ignore", "inherit", "inherit"] });
if (publish.status !== 0) process.exit(publish.status ?? 1);
