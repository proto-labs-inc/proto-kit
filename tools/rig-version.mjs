import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
// The adapter is the workspace's own dependency; rig-core is the
// adapter's, so it is resolved from there, wherever the package
// manager put it.
export function resolvedRigVersion(workspace) {
  const own = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).dependencies ?? {};
  const adapter = ["@proto-labs-inc/rig", "@proto-labs-inc/rig-vue"].find((name) => name in own);
  if (!adapter) throw new Error(`${workspace}/package.json depends on neither @proto-labs-inc/rig nor @proto-labs-inc/rig-vue`);
  try {
    const adapterPackage = createRequire(join(workspace, "package.json")).resolve(`${adapter}/package.json`);
    const corePackage = createRequire(adapterPackage).resolve("@proto-labs-inc/rig-core/package.json");
    return JSON.parse(readFileSync(corePackage, "utf8")).version;
  } catch {
    // A starter copied unchanged ships its saved build without installing:
    // its lockfile names the rig it was built with.
    const locked = lockedRigCoreVersion(workspace);
    if (locked) return locked;
    throw new Error(`@proto-labs-inc/rig-core does not resolve from ${workspace}; run pnpm install there first`);
  }
}

/** The rig-core version a workspace's pnpm lockfile pins, or null. */
function lockedRigCoreVersion(workspace) {
  const lock = join(workspace, "pnpm-lock.yaml");
  if (!existsSync(lock)) return null;
  const versions = new Set([...readFileSync(lock, "utf8").matchAll(/^\s+'?@proto-labs-inc\/rig-core@(\d+\.\d+\.\d+)/gm)].map((m) => m[1]));
  return versions.size === 1 ? [...versions][0] : null;
}
