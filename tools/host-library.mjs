#!/usr/bin/env node
/**
 * Put the codebase's library online in one call, so the import has
 * somewhere for the user to watch before it extracts anything (ADR
 * 0003; serve skill, "The library"). Idempotent: run it again and it
 * repairs what is missing and prints the same addresses.
 *
 *   1. Scaffold template/library into ~/.proto/<codebase>/library if
 *      it is not there yet, and replace the app with this kit's copy
 *      on every run (the import's public/ and unit folders stay).
 *   2. pnpm install --frozen-lockfile there, once per codebase and
 *      again when the kit's lockfile changes.
 *   3. Settle this run's port — the one an up run is already bound
 *      to, else a free one — then provision_tunnel { kind: "library",
 *      codebase, port } through the Proto app, which chooses and
 *      stores the address. This happens before anything could look the
 *      hostname up: a lookup that finds no record is remembered as
 *      "does not exist" for thirty minutes.
 *   4. Write run/library/spec.json (Vite dev server, cloudflared,
 *      the liveness beat) and start it under supervise.mjs.
 *   5. Wait for the dev server locally, then read cloudflared's own
 *      log for whether it reached Cloudflare, and verify through the
 *      edge with --resolve (never a plain lookup) when it did.
 *
 * Once the dev server answers, this call succeeds (MAA-182). A network
 * that blocks the tunnel's port, as guest and corporate Wi-Fi commonly
 * do, is named in one sentence and does not fail the run: the library
 * is up locally, publishing goes over 443 and works, and the import
 * that called this has everything it needs. Failing here was how an
 * import came to extract nothing at all.
 *
 * Prints, one per line: the public URL, the local URL, the run dir, and
 * whether the tunnel is connected or blocked.
 *
 * Usage: node host-library.mjs <codebase>
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callTool } from "./mcp-call.mjs";
import { ephemeralPort } from "./ports.mjs";
import { TUNNEL_BLOCKED, TUNNEL_BLOCKED_SENTENCE, TUNNEL_CONNECTED, TUNNEL_CONNECTING, watchTunnel } from "./tunnel-state.mjs";

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
const port = servingPort ?? (await ephemeralPort());
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

// 5. Local first, then the tunnel's own verdict, then the edge. Vite's
// first start after an install can take a few seconds; cloudflared
// writes its connectivity pre-check within about fifteen and registers
// its first connection within about thirty.
const local = `http://localhost:${port}`;
step("waiting for the dev server");
await waitFor(`${local}/manifest.json`, 60_000, (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok));

// The library is up locally from here on, so nothing below may fail the
// run (MAA-182): a network that cannot carry a tunnel is a fact about
// the network, not a broken library, and the import that called this
// goes on to extract and publish over 443 as usual.
const watch = watchTunnel(runDir);
step("asking cloudflared whether it reached Cloudflare");
const tunnelStatus = await settledTunnel(watch, 40_000);
if (tunnelStatus === TUNNEL_CONNECTED) {
  step("verifying through Cloudflare's edge");
  await verifyEdge();
} else {
  console.error(`! ${TUNNEL_BLOCKED_SENTENCE}`);
  console.error(`  cloudflared is still trying; see ${runDir}/tunnel.log.`);
}

console.log(`library: ${tunnel.url}`);
console.log(`local: ${local}`);
console.log(`run: ${runDir}`);
console.log(`tunnel: ${tunnelStatus === TUNNEL_CONNECTED ? "connected" : "blocked"}`);

// Wait for cloudflared to stop being undecided: a registered connection
// or a failed pre-check, whichever comes first. Undecided at the
// deadline counts as blocked, which is what it looks like to anyone
// opening the address.
async function settledTunnel(tunnelWatch, timeoutMs) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { status } = tunnelWatch.read();
    if (status !== TUNNEL_CONNECTING) return status;
    if (Date.now() >= until) return TUNNEL_BLOCKED;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Through Cloudflare's edge only, with --resolve: a plain lookup of a
// name whose record was created moments ago is remembered as "does not
// exist" for half an hour, on this laptop and at its ISP. A tunnel that
// registered and still does not serve is worth a sentence, not a crash:
// the library is up locally either way.
async function verifyEdge() {
  const edge = edgeIp(tunnel.hostname);
  if (edge === null) return;
  const answered = await waitFor(`${tunnel.url}/manifest.json`, 45_000, (url) => {
    const probe = spawnSync("curl", ["-fsS", "--max-time", "5", "--resolve", `${tunnel.hostname}:443:${edge}`, url], { encoding: "utf8" });
    return probe.status === 0 && probe.stdout.includes('"components"');
  }, false);
  if (!answered) {
    console.error(`! ${tunnel.url} is not answering yet, though the tunnel is connected; see ${runDir}/tunnel.log and dev.log.`);
  }
}

// The port the up run's dev server was started with. A spec that does
// not name one was written before the port lived there, so its run is
// replaced rather than trusted.
function specPort() {
  if (!existsSync(specPath)) return null;
  const dev = JSON.parse(readFileSync(specPath, "utf8")).processes?.find((p) => p.name === "dev");
  const port = Number(dev?.env?.PROTO_PORT);
  return Number.isInteger(port) && port > 0 ? port : null;
}

// True once `check` passes. The dev server is the one thing worth
// failing on, so that caller passes `required`; everything after it is
// about the network and only ever reports.
async function waitFor(url, timeoutMs, check, required = true) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if (await check(url)) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (required) fail(`${url} did not answer within ${timeoutMs / 1000}s; see ${runDir}/*.log`);
  return false;
}

// One of the edge's IPs, asked of 1.1.1.1 directly: this laptop's
// resolver never sees the name. Null when the lookup itself cannot
// happen, which on a network that blocks outside resolvers is a
// sentence about the network, never a node stack trace.
function edgeIp(hostname) {
  let answer = "";
  try {
    answer = execFileSync("dig", ["+short", `@1.1.1.1`, hostname, "A"], { encoding: "utf8" });
  } catch {
    console.error(`! This network blocks DNS to 1.1.1.1, so the public address cannot be checked from here; the library is up locally and publishing still works.`);
    return null;
  }
  const ip = answer.split("\n").find((line) => /^\d+\.\d+\.\d+\.\d+$/.test(line.trim()));
  if (!ip) {
    console.error(`! dig @1.1.1.1 ${hostname} returned no address yet; the record was created moments ago, run this again in a few seconds.`);
    return null;
  }
  return ip.trim();
}
