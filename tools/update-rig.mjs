/** Keep a prototype on at least the rig version shipped by this kit. */
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { assertMaintenanceAvailable } from "./maintenance-lock.mjs";
import { frameOrigin } from "./frame-origin.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));

export function updateRigDependencies(pkg) {
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = dependencies["@proto-labs-inc/rig-vue"] ? "vue" : "react";
  const template = JSON.parse(readFileSync(join(kit, "template", `workspace-${framework}`, "package.json")));
  const updates = {};
  for (const [name, required] of Object.entries(template.dependencies)) {
    if (!name.startsWith("@proto-labs-inc/") || !(name in dependencies)) continue;
    const current = dependencies[name];
    const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(current);
    if (parts) {
      const a = parts.slice(1).map(Number);
      const b = required.split(".").map(Number);
      const difference = a.map((value, index) => value - b[index]).find((value) => value !== 0) ?? 0;
      if (difference >= 0) continue;
    }
    const section = name in (pkg.dependencies ?? {}) ? "dependencies" : "devDependencies";
    pkg[section][name] = required;
    updates[name] = required;
  }
  return updates;
}

export function upgradeRig(workspace, { run = spawnSync } = {}) {
  assertMaintenanceAvailable(join(dirname(dirname(workspace)), "run", basename(workspace)));
  const path = join(workspace, "package.json");
  const original = readFileSync(path, "utf8");
  const pkg = JSON.parse(original);
  const updates = updateRigDependencies(pkg);
  // Rig 0.2.0 loads selection tools from the Frame the manifest names.
  const manifestPath = join(workspace, "public", "prototype.json");
  const originalManifest = existsSync(manifestPath) ? readFileSync(manifestPath) : null;
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const origin = manifest ? frameOrigin(manifest) : {};
  if (origin.frameOrigin) writeFileSync(manifestPath, JSON.stringify({ ...manifest, ...origin }, null, 2) + "\n");
  if (!Object.keys(updates).length && !origin.frameOrigin) return { status: "current" };
  const manager = existsSync(join(workspace, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  const lockPath = join(workspace, manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json");
  const previousLock = existsSync(lockPath) ? readFileSync(lockPath) : null;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  const args = manager === "pnpm" ? ["install", "--no-frozen-lockfile"] : ["install"];
  const commands = Object.keys(updates).length ? [args, ["run", "build"]] : [["run", "build"]];
  for (const command of commands) {
    const result = run(manager, command, { cwd: workspace, encoding: "utf8", env: { ...process.env, CI: "true" } });
    if (result.status !== 0) {
      writeFileSync(path, original);
      if (originalManifest) writeFileSync(manifestPath, originalManifest);
      if (previousLock) writeFileSync(lockPath, previousLock);
      else rmSync(lockPath, { force: true });
      throw new Error(`Rig update failed in ${workspace}: ${manager} ${command.join(" ")}\n${result.stderr || result.stdout || result.error || "Unknown failure"}`);
    }
  }
  return { status: "updated", updates: { ...updates, ...origin } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: update-rig.mjs <workspace>");
  console.log(JSON.stringify(upgradeRig(process.argv[2])));
}
