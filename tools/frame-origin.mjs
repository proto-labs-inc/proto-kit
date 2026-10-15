/**
 * The Frame origin a prototype trusts (prototype.json's frameOrigin): the
 * rig loads its selection tools only from there (proto's ADR 0011). It is
 * the Proto app this laptop is linked to, recorded when the workspace is
 * made or its rig updated; a manifest that already names one keeps it.
 */
import { readConfig } from "./mcp-call.mjs";

/** `{ frameOrigin }` to merge into a manifest, or `{}` when there is nothing to add. */
export function frameOrigin(manifest, read = readConfig) {
  if (manifest.frameOrigin) return {};
  try {
    return { frameOrigin: new URL(read().app).origin };
  } catch {
    return {};
  }
}
