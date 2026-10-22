import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommand, changedSince, fingerprint, publishRun, publishTurn, runsOn, turnStart } from "./auto-publish.mjs";
import { takeRunLock } from "./run-lock.mjs";

const hook = (name, input, home) =>
  spawnSync(process.execPath, [fileURLToPath(new URL(`./hooks/${name}`, import.meta.url))], {
    input: JSON.stringify(input),
    env: { ...process.env, PROTO_HOME: home },
    encoding: "utf8",
  });

/** A Proto folder with one codebase "cb": prototypes and the library, each with a run. */
function laptop() {
  const home = mkdtempSync(join(tmpdir(), "proto-home-"));
  const add = (name, dev = ["pnpm", "dev"]) => {
    const workspace = name === "library" ? join(home, "cb", "library") : join(home, "cb", "prototypes", name);
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "package.json"), "{}");
    writeFileSync(join(workspace, "src", "App.tsx"), "a");
    const runDir = join(home, "cb", "run", name);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "spec.json"), JSON.stringify({ processes: [{ name: "dev", command: dev }] }));
    // Written well before any turn starts.
    const old = new Date(Date.now() - 60_000);
    for (const file of [join(workspace, "package.json"), join(workspace, "src", "App.tsx")]) utimesSync(file, old, old);
    return { workspace, runDir };
  };
  return { home, add };
}

/** Steps that record what ran instead of building or uploading. */
function fakeSteps({ build = true, publish = { ok: true, output: "published" }, open = false } = {}) {
  const calls = [];
  return {
    calls,
    openBrief: async (workspace) => (calls.push(["openBrief", workspace]), open),
    build: (workspace) => (calls.push(["build", workspace]), { ok: build, output: build ? "" : "error TS1005" }),
    publishPrototype: (workspace) => (calls.push(["publishPrototype", workspace]), publish),
    publishLibrary: (workspace) => (calls.push(["publishLibrary", workspace]), publish),
  };
}

test("the prompt hook records the turn's start for that session, and nothing for a bad id", () => {
  const { home } = laptop();
  const before = Date.now();
  assert.equal(hook("turn-start.mjs", { session_id: "s-1", hook_event_name: "UserPromptSubmit" }, home).status, 0);
  assert.ok(turnStart(home, "s-1") >= before);
  const cursor = hook("turn-start.mjs", { conversation_id: "c-1", cursor_version: "2.0" }, home);
  assert.equal(cursor.stdout.trim(), '{"continue":true}', "Cursor is told to go on");
  assert.ok(turnStart(home, "c-1") >= before);
  hook("turn-start.mjs", { session_id: "../../etc" }, home);
  assert.equal(turnStart(home, "../../etc"), null);
  assert.equal(existsSync(join(home, "etc.json")), false);
});

test("a turn publishes what changed during it, however it was changed, and nothing else", async () => {
  const { home, add } = laptop();
  const edited = add("edited");
  const shell = add("shell");
  add("untouched");
  hook("turn-start.mjs", { session_id: "s" }, home);
  writeFileSync(join(edited.workspace, "src", "App.tsx"), "b"); // an edit tool
  spawnSync("sh", ["-c", `echo c > "${join(shell.workspace, "src", "New.tsx")}"`]); // a shell command
  const steps = fakeSteps();
  const published = await publishTurn(home, "s", steps);
  assert.deepEqual(published.map((run) => run.name).sort(), ["edited", "shell"]);
  assert.equal(steps.calls.filter(([step]) => step === "publishPrototype").length, 2);
});

test("a session with no recorded turn start publishes nothing", async () => {
  const { home, add } = laptop();
  const run = add("edited");
  writeFileSync(join(run.workspace, "src", "App.tsx"), "b");
  const steps = fakeSteps();
  assert.deepEqual(await publishTurn(home, "never-started", steps), []);
  assert.deepEqual(steps.calls, []);
});

test("what a build or an install writes is not a change", () => {
  const { add } = laptop();
  const { workspace } = add("p");
  const before = fingerprint(workspace);
  const since = Date.now() - 1;
  for (const written of ["dist", "node_modules"]) {
    mkdirSync(join(workspace, written));
    writeFileSync(join(workspace, written, "out.js"), "x");
  }
  assert.equal(changedSince(workspace, since), false);
  assert.equal(fingerprint(workspace), before);
  writeFileSync(join(workspace, "src", "App.tsx"), "ab");
  assert.equal(changedSince(workspace, since), true);
  assert.notEqual(fingerprint(workspace), before);
});

test("every run with a workspace is a candidate, up or not, and a starter is marked", () => {
  const { home, add } = laptop();
  add("served");
  add("stopped"); // no state.json at all: nothing running it
  add("starter", ["node", "/kit/tools/serve.mjs", "dist", "5200"]);
  add("library");
  const runs = runsOn(home).map((r) => `${r.kind}:${r.name}:${r.starter}`).sort();
  assert.deepEqual(runs, ["library:library:false", "prototype:served:false", "prototype:starter:true", "prototype:stopped:false"]);
});

test("an edited starter is not built; its log says what to do", async () => {
  const { home, add } = laptop();
  const { runDir } = add("starter", ["node", "/kit/tools/serve.mjs", "dist", "5200"]);
  const steps = fakeSteps();
  await publishRun(runsOn(home)[0], steps);
  assert.deepEqual(steps.calls, []);
  assert.match(readFileSync(join(runDir, "publish.log"), "utf8"), /switch it to the dev server/);
});

test("a prototype whose build request is still open is left to its skill", async () => {
  const { home, add } = laptop();
  const { runDir } = add("building");
  const steps = fakeSteps({ open: true });
  await publishRun(runsOn(home)[0], steps);
  assert.deepEqual(steps.calls.map(([step]) => step), ["openBrief"]);
  assert.match(readFileSync(join(runDir, "publish.log"), "utf8"), /build request is still open/);
});

test("a failed build publishes nothing and is tried again at the next turn end", async () => {
  const { home, add } = laptop();
  const { runDir } = add("p");
  const failing = fakeSteps({ build: false });
  await publishRun(runsOn(home)[0], failing);
  assert.equal(failing.calls.some(([step]) => step === "publishPrototype"), false);
  assert.equal(existsSync(join(runDir, "publish.retry")), true);
  // The next turn touches nothing here, and the run is published all the same.
  hook("turn-start.mjs", { session_id: "next" }, home);
  const working = fakeSteps();
  assert.deepEqual((await publishTurn(home, "next", working)).map((run) => run.name), ["p"]);
  assert.equal(existsSync(join(runDir, "publish.retry")), false);
  assert.equal(existsSync(join(runDir, "published.fingerprint")), true);
});

test("a publish the app refuses is not retried until the workspace changes", async () => {
  const { home, add } = laptop();
  const { runDir } = add("p");
  await publishRun(runsOn(home)[0], fakeSteps({ publish: { ok: false, output: "Could not prepare publishing: unknown prototype" } }));
  assert.equal(existsSync(join(runDir, "publish.retry")), false);
  hook("turn-start.mjs", { session_id: "next" }, home);
  assert.deepEqual(await publishTurn(home, "next", fakeSteps()), []);
});

test("the library goes through publish-library, and an unchanged library is not published again", async () => {
  const { home, add } = laptop();
  add("library");
  const steps = fakeSteps();
  const run = runsOn(home)[0];
  await publishRun(run, steps);
  await publishRun(run, steps);
  assert.deepEqual(steps.calls.map(([step]) => step), ["publishLibrary"]);
});

test("the library step waits for publish-library's own lock, so success means it went out", () => {
  const source = readFileSync(new URL("./auto-publish.mjs", import.meta.url), "utf8");
  assert.match(source, /publish-library\.mjs"\), workspace, "--wait"\]/);
});

test("a publish that finds the run locked leaves a request the holder picks up", async () => {
  const { home, add } = laptop();
  const { runDir } = add("p");
  const lock = join(runDir, "publish.lock");
  assert.equal(takeRunLock(lock, { wait: false }), true);
  const steps = fakeSteps();
  await publishRun(runsOn(home)[0], steps);
  assert.deepEqual(steps.calls.filter(([step]) => step !== "openBrief"), [], "nothing builds while another publish holds the lock");
  assert.equal(existsSync(join(runDir, "publish.pending")), true);
});

test("the holder goes round again for a request made while it ran, refreshing the lock", async () => {
  const { home, add } = laptop();
  const { runDir, workspace } = add("p");
  const lock = join(runDir, "publish.lock");
  const steps = fakeSteps();
  let rounds = 0;
  const build = steps.build;
  steps.build = (dir, log) => {
    rounds += 1;
    if (rounds === 1) {
      // Another turn ends mid-build, after editing again.
      utimesSync(lock, new Date(0), new Date(0));
      mkdirSync(join(runDir, "publish.pending"));
      writeFileSync(join(workspace, "src", "App.tsx"), "again");
    }
    return build(dir, log);
  };
  const publish = steps.publishPrototype;
  steps.publishPrototype = (dir, log) => {
    assert.ok(Date.now() - statSync(lock).mtimeMs < 60_000, "the lock was refreshed before uploading");
    return publish(dir, log);
  };
  await publishRun(runsOn(home)[0], steps);
  assert.equal(rounds, 2);
  assert.equal(existsSync(lock), false, "released at the end");
});

test("a held lock taken with wait gives up after its time, and a stale one is taken over", () => {
  const dir = mkdtempSync(join(tmpdir(), "proto-lock-"));
  const lock = join(dir, "publish.lock");
  assert.equal(takeRunLock(lock, { wait: false }), true);
  assert.throws(() => takeRunLock(lock, { wait: true, waitMs: 600 }), /held by another publish/);
  utimesSync(lock, new Date(0), new Date(0));
  assert.equal(takeRunLock(lock, { wait: false }), true, "a lock nobody refreshed for long belongs to a dead process");
});

test("the build uses the workspace's own package manager", () => {
  const { add } = laptop();
  const { workspace } = add("p");
  assert.deepEqual(buildCommand(workspace), ["pnpm", ["build"]]);
  writeFileSync(join(workspace, "package-lock.json"), "{}");
  assert.deepEqual(buildCommand(workspace), ["npm", ["run", "build"]]);
});

test("the end-of-turn hook answers at once, and Cursor gets JSON", () => {
  const { home } = laptop();
  assert.equal(hook("auto-publish-turn.mjs", { session_id: "none-recorded" }, home).status, 0);
  assert.equal(hook("auto-publish-turn.mjs", { conversation_id: "c", cursor_version: "2.0" }, home).stdout.trim(), "{}");
});
