#!/usr/bin/env node
/**
 * Prototype liveness heartbeat (MAA-132 step 2, ADR 0001). Runs as a
 * third process in a prototype's run spec, so its lifetime IS the
 * serving lifetime: supervise start brings it up, supervise stop
 * takes it down, and nothing beats when nothing serves. Staleness is
 * the signal; there is no "is live" flag anywhere.
 *
 * On every beat it checks its sibling processes in the run's
 * state.json (a crash-looping dev server must not claim liveness)
 * and, when all are up, calls the heartbeat MCP tool. The app answers
 * with its staleness window and the loop (heartbeat.mjs) paces itself
 * from that. Failures are logged and beating continues: a beat that
 * cannot be sent is a missed beat, never a crash.
 *
 * Usage: node prototype-heartbeat.mjs --kind prototype <run-dir> <codebase> <slug>
 *        node prototype-heartbeat.mjs --kind library <run-dir> <codebase>
 *   --kind is required: a prototype's serving run beats
 *   prototype_heartbeat; the codebase's library serving run beats
 *   library_heartbeat (no slug). account comes from
 *   ~/.proto/config.json.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { callTool, readConfig } from "./mcp-call.mjs";
import { beatForever } from "./heartbeat.mjs";

const USAGE = `usage: node prototype-heartbeat.mjs --kind prototype <run-dir> <codebase> <slug>
       node prototype-heartbeat.mjs --kind library <run-dir> <codebase>`;
const KINDS = ["prototype", "library"];
const args = process.argv.slice(2);
const kindAt = args.indexOf("--kind");
let kind = null;
let positional = args;
if (kindAt !== -1) {
  kind = args[kindAt + 1];
  positional = args.filter((_, i) => i !== kindAt && i !== kindAt + 1);
}
const [runDirArg, codebase, slug] = positional;
if (!KINDS.includes(kind)) {
  console.error(`--kind must be one of ${KINDS.join(", ")}; got ${kind ?? "nothing"}\n${USAGE}`);
  process.exit(1);
}
if (!runDirArg || !codebase || (kind === "prototype" && !slug)) {
  console.error(USAGE);
  process.exit(1);
}
const runDir = resolve(runDirArg);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// "Live" means reachable from the site, which means through the tunnel.
// A run spec without a tunnel process (a library served on localhost
// only) must never beat: the site would load a hostname that does not
// exist, and the failed lookup is cached as "does not exist" for the
// zone's negative TTL.
function siblingsUp() {
  try {
    const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
    if (!state.processes.tunnel) return false;
    return Object.entries(state.processes)
      .filter(([name]) => name !== "heartbeat")
      .every(([, p]) => alive(p.pid));
  } catch {
    return false;
  }
}

function sendBeat() {
  if (!siblingsUp()) return null; // serving is not healthy; stay silent
  const account = readConfig().account?.user;
  if (kind === "library") return callTool("library_heartbeat", { codebase, account });
  return callTool("prototype_heartbeat", { codebase, slug, account });
}

beatForever(sendBeat);
