/** The connected cloud app owns the installable rig release. Never use kit pins. */
import { readConfig } from "./mcp-call.mjs";

const names = ["@proto-labs-inc/rig-core", "@proto-labs-inc/rig", "@proto-labs-inc/rig-vue", "@proto-labs-inc/wire"];
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateRigRelease(value) {
  if (value?.schemaVersion !== 1 || !value.packages ||
      Object.keys(value.packages).length !== names.length ||
      !names.every(name => typeof value.packages[name] === "string" && version.test(value.packages[name]))) {
    throw new Error("The cloud app returned an invalid rig release. No workspace was changed.");
  }
  return { schemaVersion: 1, packages: Object.fromEntries(names.map(name => [name, value.packages[name]])) };
}

export async function fetchRigRelease({ app = readConfig().app, fetch: request = globalThis.fetch } = {}) {
  const url = new URL("/api/rig-release", app);
  const response = await request(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Could not read the cloud rig release (HTTP ${response.status}). No workspace was changed.`);
  return validateRigRelease(await response.json());
}

export function rigDependencies(release, framework) {
  const { packages } = validateRigRelease(release);
  const adapter = framework === "vue" ? "@proto-labs-inc/rig-vue" : "@proto-labs-inc/rig";
  return { [adapter]: packages[adapter], "@proto-labs-inc/wire": packages["@proto-labs-inc/wire"] };
}
