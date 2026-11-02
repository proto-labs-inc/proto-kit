/** Keep a prototype on at least the rig version shipped by this kit. */
import { existsSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, mkdtempSync, readdirSync, lstatSync, readlinkSync, renameSync } from "node:fs";
import { dirname, join, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { frameOrigin } from "./frame-origin.mjs";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));

export function updateRigDependencies(pkg) {
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = dependencies["@proto-labs-inc/rig-vue"] || dependencies.vue ? "vue" : "react";
  const template = JSON.parse(readFileSync(join(kit, "template", `workspace-${framework}`, "package.json")));
  const updates = {};
  for (const [name, required] of Object.entries(template.dependencies)) {
    if (!name.startsWith("@proto-labs-inc/")) continue;
    const current = dependencies[name];
    const parts = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(current);
    if (parts) {
      const a = parts.slice(1).map(Number);
      const b = required.split(".").map(Number);
      const difference = a.map((value, index) => value - b[index]).find((value) => value !== 0) ?? 0;
      if (difference >= 0) continue;
    }
    const section = name in (pkg.dependencies ?? {}) ? "dependencies" : "devDependencies";
    pkg[section] ??= {};
    pkg[section][name] = required;
    updates[name] = required;
  }
  return updates;
}

function upgradeCandidate(workspace, { run = spawnSync } = {}) {
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
  if (pkg.dependencies?.["@proto-labs-inc/rig-vue"] || pkg.devDependencies?.["@proto-labs-inc/rig-vue"]) {
    const entry = join(workspace, "src", "main.ts");
    if (!existsSync(entry)) throw new Error("Vue rig migration needs manual repair: missing src/main.ts");
    const source = readFileSync(entry, "utf8");
    if (!source.includes("await protoRig(")) {
      const old = 'createApp(App).use(protoRig(manifest as Manifest)).mount("#app");';
      if (!source.includes(old)) throw new Error("Vue rig migration needs manual repair: unrecognized startup; await protoRig before mounting");
      writeFileSync(entry, source.replace(old, 'async function start() {\n  const rig = await protoRig(manifest as Manifest);\n  createApp(App).use(rig).mount("#app");\n}\nvoid start().catch(error => { const root = document.querySelector("#app"); if (root) { root.textContent = "Could not load the rig. Refresh to retry."; root.setAttribute("role", "alert"); } console.error(error); });'));
    }
  }
  const manager = existsSync(join(workspace, "pnpm-lock.yaml")) ? "pnpm" : "npm";
  const lockPath = join(workspace, manager === "pnpm" ? "pnpm-lock.yaml" : "package-lock.json");
  const previousLock = existsSync(lockPath) ? readFileSync(lockPath) : null;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  const args = manager === "pnpm" ? ["install", "--no-frozen-lockfile"] : ["install"];
  const commands = [args, ["run", "build"]];
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

const GENERATED = new Set(["node_modules", "dist", ".git", ".proto-checks"]);
function fingerprint(directory) {
  const hash = createHash("sha256");
  const walk = dir => {
    for (const name of readdirSync(dir).sort()) {
      if (GENERATED.has(name)) continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      hash.update(relative(directory, path));
      if (stat.isSymbolicLink()) hash.update(readlinkSync(path));
      else if (stat.isDirectory()) walk(path);
      else hash.update(readFileSync(path));
    }
  };
  walk(directory);
  return hash.digest("hex");
}

/** Explicit manual upgrade only. Never run from an idle/background scheduler. */
export function upgradeRig(workspace, { run = spawnSync, verify } = {}) {
  const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"));
  const manifestPath = join(workspace, "public", "prototype.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  if (!Object.keys(updateRigDependencies(structuredClone(pkg))).length && !(manifest && frameOrigin(manifest).frameOrigin)) return { status: "current" };
  if (existsSync(join(workspace, ".git"))) throw new Error("Only independent prototype workspaces can be migrated; do not replace a Git checkout");
  const lock = join(dirname(workspace), `.${basename(workspace)}-rig-upgrade.lock`);
  // A stale lock is intentionally not stolen. Inspect retained candidates/backups
  // after an interrupted migration before removing it for an explicit retry.
  const checkIdle = () => {
    if (verify) return; // Unit tests supply their own verifier and run boundary.
    const port = manifest?.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Migration needs the prototype manifest's valid preview port");
    const probe = run(process.execPath, ["--input-type=module", "-e", `import net from 'node:net'; const s=net.createConnection({host:'127.0.0.1',port:${port}}); s.on('connect',()=>{s.destroy();process.exit(1)}); s.on('error',()=>process.exit(0)); s.setTimeout(1500,()=>{s.destroy();process.exit(2)});`], { encoding: "utf8" });
    if (probe.status !== 0) throw new Error("Stop this prototype's managed preview and other agent edits before applying its rig migration; the original workspace is unchanged");
  };
  checkIdle();
  const before = fingerprint(workspace);
  const candidate = mkdtempSync(join(dirname(workspace), `.${basename(workspace)}-rig-candidate-`));
  const backup = `${candidate}-previous`;
  try { mkdirSync(lock); } catch (error) { rmSync(candidate, { recursive: true, force: true }); throw error; }
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, workspace }));
  let applied = false;
  try {
    cpSync(workspace, candidate, { recursive: true, filter: path => !GENERATED.has(basename(path)) });
    const result = upgradeCandidate(candidate, { run });
    if (verify) verify(candidate);
    else {
      const check = run(process.execPath, [join(kit, "tools", "verify-rig-upgrade.mjs"), candidate], { encoding: "utf8", env: process.env });
      if (check.status !== 0) throw new Error(`Rig verification failed: ${check.stderr || check.stdout || check.error}`);
    }
    checkIdle();
    if (fingerprint(workspace) !== before) throw new Error("Prototype changed during rig verification; no changes applied. Retry when editing is idle.");
    // Keep the prior workspace for explicit recovery, including its dependencies.
    writeFileSync(join(lock, "recovery.json"), JSON.stringify({ workspace, candidate, backup, status: "prepared" }));
    renameSync(workspace, backup);
    try {
      if (fingerprint(backup) !== before) throw new Error("Prototype changed while applying the rig upgrade; restoring its workspace");
      renameSync(candidate, workspace);
    }
    catch (error) { renameSync(backup, workspace); throw error; }
    applied = true;
    writeFileSync(`${backup}.json`, JSON.stringify({ workspace, backup, status: "applied", publication: "required" }, null, 2));
    return { ...result, backup, publication: "required" };
  } finally {
    if (!applied) rmSync(candidate, { recursive: true, force: true });
    if (existsSync(workspace)) rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("usage: update-rig.mjs <workspace>");
  console.log(JSON.stringify(upgradeRig(process.argv[2])));
}
