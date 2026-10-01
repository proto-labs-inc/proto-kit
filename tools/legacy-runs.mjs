/** Recognize retired command-listener artifacts without starting or repairing them. */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export const LEGACY_SCRIPTS = new Set(["courier.mjs", "courier-up.mjs", "feed-tail.mjs", "feed-watch-all.mjs", "feed-queue.mjs", "feed-drive.mjs", "agent-launch.mjs", "codex-thread.mjs"]);
export function readLegacyJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}
export function isLegacyCourierRun(dir, spec = readLegacyJson(join(dir, "spec.json"))) {
  if (basename(dir) === "courier" || existsSync(join(dir, "courier.json")) || (typeof spec?.name === "string" && spec.name.endsWith("/courier"))) return true;
  return Array.isArray(spec?.processes) && spec.processes.some((entry) => entry?.name === "codex-wake" ||
    (Array.isArray(entry?.command) && entry.command.some((arg) => typeof arg === "string" && LEGACY_SCRIPTS.has(basename(arg)))));
}
