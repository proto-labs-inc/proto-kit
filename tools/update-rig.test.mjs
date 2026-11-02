const release = { schemaVersion: 1, packages: { "@proto-labs-inc/rig-core": "0.3.1", "@proto-labs-inc/rig": "0.3.1", "@proto-labs-inc/rig-vue": "0.3.1", "@proto-labs-inc/wire": "0.3.0" } };
import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateRigDependencies, upgradeRig } from "./update-rig.mjs";

test("upgrades pinned and vendored rigs without downgrading newer packages", () => {
  const pkg = { dependencies: { "@proto-labs-inc/rig": "0.1.0", "@proto-labs-inc/wire": "0.2.0", react: "19" } };
  assert.deepEqual(updateRigDependencies(pkg, release), { "@proto-labs-inc/rig": "0.3.1", "@proto-labs-inc/wire": "0.3.0" });
  assert.equal(pkg.dependencies["@proto-labs-inc/wire"], "0.3.0");
  assert.equal(pkg.dependencies.react, "19");
  assert.deepEqual(updateRigDependencies(pkg, release), {});
  const vue = { devDependencies: { "@proto-labs-inc/rig-vue": "file:vendor/rig.tgz", "@proto-labs-inc/wire": "0.1.0" } };
  assert.deepEqual(updateRigDependencies(vue, release), { "@proto-labs-inc/rig-vue": "0.3.1", "@proto-labs-inc/wire": "0.3.0" });
});

test("old prepared copies install and rebuild; current copies need no commands", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "rig-update-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ dependencies: { "@proto-labs-inc/rig": "0.1.0" } }));
  writeFileSync(join(workspace, "pnpm-lock.yaml"), "");
  const calls = [];
  const run = (manager, args) => { calls.push([manager, ...args]); return { status: 0 }; };
  assert.equal(upgradeRig(workspace, { release, run, verify: () => {} }).status, "updated");
  assert.deepEqual(calls, [["pnpm", "install", "--no-frozen-lockfile"], ["pnpm", "run", "build"]]);
  assert.equal(upgradeRig(workspace, { release, run, verify: () => {} }).status, "current");
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(readFileSync(join(workspace, "package.json"))).dependencies["@proto-labs-inc/rig"], "0.3.1");
});

test("failed installs restore the manifest and lockfile so a retry still upgrades", (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "rig-update-failed-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const original = JSON.stringify({ dependencies: { "@proto-labs-inc/rig": "0.1.0" } });
  writeFileSync(join(workspace, "package.json"), original);
  writeFileSync(join(workspace, "pnpm-lock.yaml"), "original lock");
  const fail = (_manager, _args, options) => {
    writeFileSync(join(options.cwd, "pnpm-lock.yaml"), "partial lock");
    return { status: 1, stderr: "network unavailable" };
  };
  assert.throws(() => upgradeRig(workspace, { release, run: fail, verify: () => {} }), /network unavailable/);
  assert.equal(readFileSync(join(workspace, "package.json"), "utf8"), original);
  assert.equal(readFileSync(join(workspace, "pnpm-lock.yaml"), "utf8"), "original lock");
  assert.equal(upgradeRig(workspace, { release, run: () => ({ status: 0 }), verify: () => {} }).status, "updated");
});

// A live preview must keep its original workspace, including IPv6-only Vite.
for (const host of ["127.0.0.1", "::1"]) {
  test(`refuses to replace a workspace served on ${host}`, async (t) => {
    const { createServer } = await import("node:net");
    const server = createServer(socket => socket.end());
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port: 0, ipv6Only: host === "::1" }, resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const workspace = mkdtempSync(join(tmpdir(), "rig-update-live-"));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const original = JSON.stringify({ dependencies: { "@proto-labs-inc/rig": "0.1.0" } });
    writeFileSync(join(workspace, "package.json"), original);
    mkdirSync(join(workspace, "public"));
    writeFileSync(join(workspace, "public", "prototype.json"), JSON.stringify({ port: server.address().port }));
    const run = (command, args, options) => {
      assert.equal(command, process.execPath, "a running preview must block before dependency installation");
      return spawnSync(command, args, options);
    };
    assert.throws(() => upgradeRig(workspace, { release, run }), /Stop this prototype's managed preview/);
    assert.equal(readFileSync(join(workspace, "package.json"), "utf8"), original);
  });
}
