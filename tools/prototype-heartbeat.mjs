#!/usr/bin/env node
/**
 * Prototype liveness heartbeat (MAA-132 step 2, ADR 0001). Runs as a
 * third process in a prototype's run spec, so its lifetime IS the
 * serving lifetime: supervise start brings it up, supervise stop
 * takes it down, and nothing beats when nothing serves. Staleness is
 * the signal; there is no "is live" flag anywhere.
 *
 * Every ~15s it checks its sibling processes in the run's state.json
 * (a crash-looping dev server must not claim liveness) and, when all
 * are up, calls the `prototype_heartbeat` MCP tool. Failures are
 * logged and beating continues: a beat that cannot be sent is a
 * missed beat, never a crash. The app treats a prototype as not live
 * after ~45s of silence.
 *
 * Usage: node prototype-heartbeat.mjs <run-dir> <product> <slug>
 *   account comes from ~/.proto/config.json.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callTool } from "./mcp-call.mjs";

const [runDirArg, product, slug] = process.argv.slice(2);
if (!runDirArg || !product || !slug) {
  console.error("usage: node prototype-heartbeat.mjs <run-dir> <product> <slug>");
  process.exit(1);
}
const runDir = resolve(runDirArg);
const account = (() => {
  try {
    return JSON.parse(readFileSync(join(process.env.HOME ?? "", ".proto", "config.json"), "utf8"))
      .account?.user;
  } catch {
    return undefined;
  }
})();

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function siblingsUp() {
  try {
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    return Object.entries(state.processes)
      .filter(([name]) => name !== "heartbeat")
      .every(([, p]) => alive(p.pid));
  } catch {
    return false;
  }
}

async function beat() {
  if (!siblingsUp()) return; // serving is not healthy; stay silent
  try {
    await callTool("prototype_heartbeat", { product, slug, account });
  } catch (e) {
    console.log(`heartbeat not sent (${e.message}); still beating`);
  }
}

beat();
setInterval(beat, 15_000);
