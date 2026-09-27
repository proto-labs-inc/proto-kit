#!/usr/bin/env node
/**
 * Put the codebase's library online in one call, so the import has
 * somewhere for the user to watch before it extracts anything (ADR
 * 0003; serve skill, "The library"). Idempotent: run it again and it
 * repairs what is missing and prints the same addresses.
 *
 *   1. Scaffold template/library into ~/.proto/<codebase>/library if
 *      it is not there yet, and refresh vite.config.ts from the
 *      template so the dev server reads this run's port.
 *   2. pnpm install --frozen-lockfile there, once per codebase.
 *   3. Settle this run's port — the one an up run is already bound
 *      to, else a free one — then provision_tunnel { kind: "library",
 *      codebase, port } through the Proto app, which chooses and
 *      stores the address. This happens before anything could look the
 *      hostname up: a lookup that finds no record is remembered as
 *      "does not exist" for thirty minutes.
 *   4. Write run/library/spec.json (Vite dev server, cloudflared,
 *      the liveness beat) and start it under supervise.mjs.
 *   5. Wait for the dev server locally, then verify through
 *      Cloudflare's edge with --resolve (never a plain lookup).
 *
 * Prints, one per line: the public URL, the local URL, the run dir.
 *
 * Usage: node host-library.mjs <codebase>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool } from "./mcp-call.mjs";

const codebase = process.argv[2];
if (!codebase) {
  console.error("usage: node host-library.mjs <codebase>");
  process.exit(1);
}
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const home = join(process.env.HOME ?? "", ".proto", codebase);
const library = join(home, "library");
const runDir = join(home, "run", "library");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const step = (message) => console.error(`… ${message}`);

// 1. Scaffold. node_modules and dist never come from the template.
if (!existsSync(join(library, "package.json"))) {
  if (!existsSync(join(home, "codebase.json"))) fail(`${home} has no codebase.json; run setup first`);
  step(`scaffolding the library app into ${library}`);
  cpSync(join(kit, "template", "library"), library, {
    recursive: true,
    filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source),
  });
}

// The dev server's config is the kit's, not the copy's: it is what
// reads PROTO_PORT, so a codebase scaffolded by an older kit picks up
// this run's port. The import's own work lives in src/ and public/.
cpSync(join(kit, "template", "library", "vite.config.ts"), join(library, "vite.config.ts"));

// 2. Install, once.
if (!existsSync(join(library, "node_modules"))) {
  step("installing the library's dependencies (once per codebase)");
  const install = spawnSync("pnpm", ["install", "--frozen-lockfile"], { cwd: library, stdio: ["ignore", "inherit", "inherit"] });
  if (install.status !== 0) fail("pnpm install failed in the library folder");
}

// 3. The port for this run, and the address the site chooses for it.
// The port belongs to the run, not to the kit, so two codebases can
// serve their libraries at the same time.
//
// A run that is already up keeps the port its dev server bound, and
// every other run takes a free one. That asymmetry is what keeps this
// script idempotent, and the import skill runs it first thing: taking
// a fresh port here would re-provision the tunnel onto a port the
// running dev server is not listening on, and the library the caller
// asked about would go dark.
mkdirSync(runDir, { recursive: true });
const unwrap = (result) => {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.split("\n")[0] };
  }
};
const supervise = join(kit, "tools", "supervise.mjs");
const specPath = join(runDir, "spec.json");
const status = spawnSync(process.execPath, [supervise, "status", runDir], { encoding: "utf8" });
const servingPort = status.status === 0 && !status.stdout.includes("DOWN") ? specPort() : null;
const port = servingPort ?? (await freePort());
step(`provisioning the library tunnel for port ${port}`);
const tunnel = unwrap(await callTool("provision_tunnel", { kind: "library", codebase, port }).catch((e) => ({ content: [{ text: e.message }] })));
if (!tunnel.url || !tunnel.hostname || !tunnel.connectorToken) fail(`provision_tunnel did not answer with an address: ${tunnel.error ?? JSON.stringify(tunnel)}`);
writeFileSync(join(runDir, "tunnel.json"), JSON.stringify({ url: tunnel.url, hostname: tunnel.hostname, port }, null, 2) + "\n");

// 4. The run: three processes, exactly as the serve skill shows.
const spec = {
  name: `${codebase}/library`,
  processes: [
    { name: "dev", cwd: library, command: ["pnpm", "dev"], env: { PROTO_TUNNEL: "1", PROTO_PORT: String(port) } },
    { name: "tunnel", command: ["cloudflared", "tunnel", "run", "--token", tunnel.connectorToken] },
    { name: "heartbeat", command: ["node", join(kit, "tools", "prototype-heartbeat.mjs"), "--kind", "library", runDir, codebase] },
  ],
};
writeFileSync(specPath, JSON.stringify(spec, null, 2) + "\n");
chmodSync(specPath, 0o600);
if (servingPort) {
  step("the library run is already up");
} else {
  if (status.status === 0) spawnSync(process.execPath, [supervise, "stop", runDir]);
  step("starting the library run under the supervisor");
  const started = spawnSync(process.execPath, [supervise, "start", runDir], { encoding: "utf8" });
  if (started.status !== 0) fail(`supervise start failed: ${started.stderr}`);
}

// 5. Local first, then the edge. Vite's first start after an install
// can take a few seconds; a fresh tunnel needs up to ~30 s to register.
const local = `http://localhost:${port}`;
step("waiting for the dev server");
await waitFor(`${local}/manifest.json`, 60_000, (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok));
step("verifying through Cloudflare's edge");
const edge = edgeIp(tunnel.hostname);
await waitFor(`${tunnel.url}/manifest.json`, 45_000, (url) => {
  const probe = spawnSync("curl", ["-fsS", "--max-time", "5", "--resolve", `${tunnel.hostname}:443:${edge}`, url], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.includes('"components"');
});

console.log(`library: ${tunnel.url}`);
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

// A port nothing holds right now. The socket closes before Vite binds,
// and Vite's strictPort turns anything that grabs it in between into a
// loud failure rather than a silent move to an address the tunnel does
// not carry.
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

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

// One of the edge's IPs, asked of 1.1.1.1 directly: this laptop's
// resolver never sees the name.
function edgeIp(hostname) {
  const answer = execFileSync("dig", ["+short", `@1.1.1.1`, hostname, "A"], { encoding: "utf8" });
  const ip = answer.split("\n").find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line.trim()));
  if (!ip) fail(`dig @1.1.1.1 ${hostname} returned no address yet; the record was created moments ago, run this again in a few seconds`);
  return ip.trim();
}
