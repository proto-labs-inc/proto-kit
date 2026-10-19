#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createHash } from "node:crypto";
import { callTool } from "./mcp-call.mjs";
import { completionProblems } from "./import-evidence.mjs";

import { requireAllStages } from "./import-stages.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export async function finishImport(codebase, deps = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(codebase ?? "")) throw new Error("Usage: finish-import.mjs <codebase>");
  const library = join(deps.home ?? join(process.env.HOME ?? "", ".proto"), codebase, "library");
  const before = JSON.parse(readFileSync(join(library, "public", "manifest.json"), "utf8"));
  if (before.codebase !== codebase) throw new Error("The library manifest names a different codebase.");
  const run = deps.run ?? ((tool, args) => spawnSync(process.execPath, [join(here, tool), ...args], { encoding: "utf8" }));
  const complete = await run("library.mjs", ["complete", library]);
  if (complete.status !== 0) throw new Error(complete.stderr?.trim() || "The library could not be completed.");
  const manifestPath = join(library, "public", "manifest.json");
  const digest = () => createHash("sha256").update(readFileSync(manifestPath)).digest("hex");
  const fingerprint = digest();
  const checkpointPath = join(library, ".import-publication.json");
  const receiptPath = join(library, ".publish-receipt.json");
  let checkpoint = existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, "utf8")) : null;
  if (!checkpoint || checkpoint.fingerprint !== fingerprint) {
    const published = await run("publish-library.mjs", [library, "--receipt", receiptPath, "--wait"]);
    if (published.status !== 0) throw new Error("The import is complete locally, but publication failed. Run finish-import again to retry publication.");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    if (receipt.codebase !== codebase || !/^\d{8}T\d{6}Z-[0-9a-f]{4}$/.test(receipt.buildId)) throw new Error("Publication returned an invalid build receipt.");
    if (digest() !== fingerprint) throw new Error("The library changed while publishing. Recheck it and run finish-import again.");
    checkpoint = { ...receipt, fingerprint };
    writeFileSync(checkpointPath, JSON.stringify(checkpoint) + "\n");
  }
  const manifest = JSON.parse(readFileSync(join(library, "public", "manifest.json"), "utf8"));
  if (!manifest.completedAt || completionProblems(library, manifest).length) throw new Error("The library changed while publishing. Recheck changed components and run finish-import again.");
  requireAllStages(library, manifest);
  const response = await (deps.callTool ?? callTool)("report_design_system_import", { codebase, report: { status: "complete", buildId: checkpoint.buildId } });
  if (response?.isError) {
    const message = response.content?.[0]?.text ?? "unknown error";
    if (/Publish the completed library|library changed/i.test(message)) rmSync(checkpointPath, { force: true });
    throw new Error(`The library was published, but completion reporting failed. Run finish-import again to retry: ${message}`);
  }
  return { outcome: "published", buildId: checkpoint.buildId, codebase, completedAt: manifest.completedAt, built: manifest.components.filter((component) => component.status === "done").length, skipped: manifest.components.filter((component) => component.status === "skipped").map(({ slug, reason }) => ({ slug, reason })) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: finish-import.mjs <codebase>");
    console.log(JSON.stringify(await finishImport(process.argv[2])));
  } catch (error) {
    console.log(JSON.stringify({ outcome: "failed", message: error.message }));
    console.error(error.message);
    process.exitCode = 1;
  }
}
