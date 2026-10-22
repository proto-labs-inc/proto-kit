import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprint, servedRuns } from "./auto-publish.mjs";

test("a workspace's fingerprint moves with its source and ignores what a build or install writes", () => {
  const workspace = mkdtempSync(join(tmpdir(), "proto-fingerprint-"));
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "App.tsx"), "a");
  const before = fingerprint(workspace);
  for (const written of ["dist", "node_modules"]) {
    mkdirSync(join(workspace, written));
    writeFileSync(join(workspace, written, "out.js"), "x");
  }
  assert.equal(fingerprint(workspace), before);
  writeFileSync(join(workspace, "src", "App.tsx"), "ab");
  assert.notEqual(fingerprint(workspace), before);
});

test("only runs whose supervisor is up and that have something to build are published", () => {
  const home = mkdtempSync(join(tmpdir(), "proto-home-"));
  const run = (name, dev, pid) => {
    const dir = join(home, "cb", "run", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "spec.json"), JSON.stringify({ processes: [{ name: "dev", command: dev }] }));
    writeFileSync(join(dir, "state.json"), JSON.stringify({ pid }));
  };
  for (const slug of ["up", "down", "starter"]) {
    mkdirSync(join(home, "cb", "prototypes", slug), { recursive: true });
    writeFileSync(join(home, "cb", "prototypes", slug, "package.json"), "{}");
  }
  mkdirSync(join(home, "cb", "library"), { recursive: true });
  writeFileSync(join(home, "cb", "library", "package.json"), "{}");
  run("up", ["pnpm", "dev"], process.pid);
  run("down", ["pnpm", "dev"], 999999);
  run("starter", ["node", "/kit/tools/serve.mjs", "dist", "5200"], process.pid);
  run("library", ["pnpm", "dev"], process.pid);
  const runs = servedRuns(home).map((r) => `${r.kind}:${r.name}`).sort();
  assert.deepEqual(runs, ["library:library", "prototype:up"]);
});

test("an edit inside a served workspace asks for that run alone to be published", () => {
  const home = mkdtempSync(join(tmpdir(), "proto-home-"));
  for (const run of ["edited", "other", "library"]) mkdirSync(join(home, "cb", "run", run), { recursive: true });
  const hook = fileURLToPath(new URL("./hooks/post-edit-markers.mjs", import.meta.url));
  const edit = (file) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ tool_input: { file_path: join(home, "cb", ...file) } }),
    env: { ...process.env, PROTO_HOME: home },
  });
  edit(["prototypes", "edited", "src", "App.tsx"]);
  edit(["library", "src", "components", "button", "Button.tsx"]);
  edit(["prototypes", "not-served", "src", "App.tsx"]);
  const requested = (run) => existsSync(join(home, "cb", "run", run, "publish.requested"));
  assert.equal(requested("edited"), true);
  assert.equal(requested("library"), true);
  assert.equal(requested("other"), false, "a workspace the turn did not touch is not published");
  assert.equal(existsSync(join(home, "cb", "run", "not-served")), false, "an unserved workspace gets no run folder");
});
