#!/usr/bin/env node
/**
 * Serve the codebase's library on this laptop in one call, so the import
 * has somewhere for the user to watch before it extracts anything (ADR
 * 0003; serve skill, "The library"). Idempotent: run it again and it
 * repairs what is missing and prints the same addresses.
 *
 *   1. Scaffold template/library into ~/.proto/<codebase>/library if
 *      it is not there yet, and replace the app with this kit's copy
 *      on every run (the import's public/ and unit folders stay).
 *   2. pnpm install --frozen-lockfile there, once per codebase and
 *      again when the kit's lockfile changes.
 *   3. Settle this run's port (the one an up run is already bound to,
 *      else a free one) and record it in run/library/local.json, where
 *      the checks and the Proto desktop app find it.
 *   4. Write run/library/spec.json (the Vite dev server) and start it
 *      under supervise.mjs.
 *   5. Wait for the dev server to answer.
 *
 * The maker sees this local library in the Proto desktop app; everyone
 * else sees its published copy, which the import publishes after each
 * component and the end of every agent turn publishes again
 * (auto-publish.mjs).
 *
 * Prints, one per line: the local URL and the run dir.
 *
 * Usage: node host-library.mjs <codebase>
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool } from "./mcp-call.mjs";
import { ephemeralPort } from "./ports.mjs";
import { protoHome } from "./proto-home.mjs";

const codebase = process.argv[2];
if (!codebase) {
  console.error("usage: node host-library.mjs <codebase>");
  process.exit(1);
}
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const home = join(protoHome(), codebase);
const library = join(home, "library");
const runDir = join(home, "run", "library");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const step = (message) => console.error(`… ${message}`);

const approval = await callTool("screen_index", { operation: "library-check", codebase });
if (approval.isError) fail(approval.content?.find(item => item.type === "text")?.text ?? "Confirm screenshots before preparing the library.");

// 1. Scaffold. node_modules and dist never come from the template.
if (!existsSync(join(library, "package.json"))) {
  if (!existsSync(join(home, "codebase.json"))) fail(`${home} has no codebase.json; run setup first`);
  step(`scaffolding the library app into ${library}`);
  cpSync(join(kit, "template", "library"), library, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source),
  });
}

// The app is the kit's; the import's work is public/ and each unit's
// folder under src/components/. Every run replaces the app with this
// kit's copy, so a library scaffolded by an older kit looks and
// behaves like the current one, and never touches the import's work.
const template = join(kit, "template", "library");
const lockBefore = existsSync(join(library, "pnpm-lock.yaml")) ? readFileSync(join(library, "pnpm-lock.yaml"), "utf8") : "";
const units = join(library, "src", "components");
const shipped = new Set(readdirSync(join(template, "src", "components")));
for (const entry of existsSync(units) ? readdirSync(units, { withFileTypes: true }) : []) {
  const unit = entry.isDirectory() && !shipped.has(entry.name);
  if (!unit) rmSync(join(units, entry.name), { recursive: true, force: true });
}
for (const entry of readdirSync(join(library, "src"), { withFileTypes: true })) {
  if (entry.name !== "components") rmSync(join(library, "src", entry.name), { recursive: true, force: true });
}
cpSync(template, library, {
  recursive: true,
  filter: (source) => !/[\\/](node_modules|dist|public)([\\/]|$)/.test(source.slice(template.length)),
});
const lockChanged = readFileSync(join(library, "pnpm-lock.yaml"), "utf8") !== lockBefore;

// 2. Install, once per codebase and again when the kit's lockfile moves.
if (!existsSync(join(library, "node_modules")) || lockChanged) {
  step("installing the library's dependencies (once per codebase)");
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: library, stdio: ["ignore", "inherit", "inherit"] });
  if (install.status !== 0) fail("pnpm install failed in the library folder");
}

// 3. The port for this run. The port belongs to the run, not to the
// kit, so two codebases can serve their libraries at the same time.
//
// A run that is already up keeps the port its dev server bound, and
// every other run takes a free one. That asymmetry is what keeps this
// script idempotent, and the import skill runs it first thing.
mkdirSync(runDir, { recursive: true });
const supervise = join(kit, "tools", "supervise.mjs");
const specPath = join(runDir, "spec.json");
const status = spawnSync(process.execPath, [supervise, "status", runDir], { encoding: "utf8" });
// A run an older kit started also ran a tunnel and a heartbeat; it is
// replaced by a run of the dev server alone, on the same port.
const oldRun = existsSync(specPath) && JSON.parse(readFileSync(specPath, "utf8")).processes?.some((p) => p.name !== "dev");
const up = status.status === 0 && !status.stdout.includes("DOWN");
const servingPort = up ? specPort() : null;
const port = servingPort ?? (await ephemeralPort());
writeFileSync(join(runDir, "local.json"), JSON.stringify({ port }, null, 2) + "\n");
rmSync(join(runDir, "tunnel.json"), { force: true });

// 4. The run: the dev server, exactly as the serve skill shows.
const spec = {
  name: `${codebase}/library`,
  processes: [{ name: "dev", cwd: library, command: ["pnpm", "dev"], env: { PROTO_PORT: String(port) } }],
};
writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
if (servingPort && !oldRun) {
  step("the library run is already up");
} else {
  if (status.status === 0) spawnSync(process.execPath, [supervise, "stop", runDir]);
  step("starting the library run under the supervisor");
  const started = spawnSync(process.execPath, [supervise, "start", runDir], { encoding: "utf8" });
  if (started.status !== 0) fail(`supervise start failed: ${started.stderr}`);
}

// 5. Vite's first start after an install can take a few seconds.
const local = `http://localhost:${port}`;
step("waiting for the dev server");
await waitFor(`${local}/manifest.json`, 60_000, (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok));

console.log(`local: ${local}`);
console.log(`run: ${runDir}`);

// The port the up run's dev server was started with. A spec that does
// not name one was written before the port lived there, so its run is
// replaced rather than trusted.
function specPort() {
  if (!existsSync(specPath)) return null;
  const dev = JSON.parse(readFileSync(specPath, "utf8")).processes?.find((p) => p.name === "dev");
  const port = Number(dev?.env?.PROTO_PORT);
  return Number.isInteger(port) && port > 0 ? port : null;
}

// True once `check` passes, or the run fails with where to look.
async function waitFor(url, timeoutMs, check) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await check(url)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  fail(`${url} did not answer within ${timeoutMs / 1000}s; see ${runDir}/*.log`);
}
