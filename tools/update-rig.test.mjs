import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateRigDependencies, upgradeRig } from "./update-rig.mjs";

test("upgrades pinned and vendored rigs without downgrading newer packages", () => {
  const pkg = { dependencies: { "@proto-labs-inc/rig": "0.1.0", "@proto-labs-inc/wire": "0.2.0", react: "19" } };
  assert.deepEqual(updateRigDependencies(pkg), { "@proto-labs-inc/rig": "0.2.5", "@proto-labs-inc/wire": "0.2.4" });
  assert.equal(pkg.dependencies["@proto-labs-inc/wire"], "0.2.4");
  assert.equal(pkg.dependencies.react, "19");
  assert.deepEqual(updateRigDependencies(pkg), {});
  const vue = { devDependencies: { "@proto-labs-inc/rig-vue": "file:vendor/rig.tgz", "@proto-labs-inc/wire": "0.1.0" } };
  assert.deepEqual(updateRigDependencies(vue), { "@proto-labs-inc/rig-vue": "0.2.5", "@proto-labs-inc/wire": "0.2.4" });
});

test("old prepared copies install and rebuild; current copies need no commands", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "rig-update-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ dependencies: { "@proto-labs-inc/rig": "0.1.0" } }));
  writeFileSync(join(workspace, "pnpm-lock.yaml"), "");
  const calls = [];
  const run = (manager, args) => { calls.push([manager, ...args]); return { status: 0 }; };
  assert.equal(upgradeRig(workspace, { run }).status, "updated");
  assert.deepEqual(calls, [["pnpm", "install", "--no-frozen-lockfile"], ["pnpm", "run", "build"]]);
  assert.equal(upgradeRig(workspace, { run }).status, "current");
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(readFileSync(join(workspace, "package.json"))).dependencies["@proto-labs-inc/rig"], "0.2.5");
});

test("failed installs restore the manifest and lockfile so a retry still upgrades", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "rig-update-failed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const original = JSON.stringify({ dependencies: { "@proto-labs-inc/rig": "0.1.0" } });
  writeFileSync(join(workspace, "package.json"), original);
  writeFileSync(join(workspace, "pnpm-lock.yaml"), "original lock");
  const fail = () => {
    writeFileSync(join(workspace, "pnpm-lock.yaml"), "partial lock");
    return { status: 1, stderr: "network unavailable" };
  };
  assert.throws(() => upgradeRig(workspace, { run: fail }), /network unavailable/);
  assert.equal(readFileSync(join(workspace, "package.json"), "utf8"), original);
  assert.equal(readFileSync(join(workspace, "pnpm-lock.yaml"), "utf8"), "original lock");
  assert.equal(upgradeRig(workspace, { run: () => ({ status: 0 }) }).status, "updated");
});
