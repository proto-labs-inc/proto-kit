import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
