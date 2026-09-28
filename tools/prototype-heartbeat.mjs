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
 * and, when all are up, hands the loop (heartbeat.mjs) the target to
 * beat for. The app answers with its staleness window and the loop
 * paces itself from that. Failures are logged and beating continues:
 * a beat that cannot be sent is a missed beat, never a crash.
 *
 * The beat carries whether the tunnel is actually connected
 * (MAA-182), read from cloudflared's own log by tunnel-state.mjs. A
 * network that blocks port 7844 leaves cloudflared alive and
 * retrying forever, and every beat still reaches Proto, because
 * beats go out over 443 and are unaffected. So the beat must say
 * which of two things is true: the laptop is serving and the public
 * address works, or the laptop is fine and that address is dead. It
 * keeps beating either way: silence would mean "asleep or gone",
 * which is a third thing and needs different words on screen.
 * Nothing restarts when the network recovers; the field flips on the
 * next beat once cloudflared registers a connection.
 *
 * Usage: node prototype-heartbeat.mjs --kind prototype <run-dir> <codebase> <slug>
 *        node prototype-heartbeat.mjs --kind library <run-dir> <codebase>
 *   --kind is required and is the heartbeat tool's kind: a
 *   prototype's serving run beats for { kind: "prototype", codebase,
 *   slug }; the codebase's library serving run beats for
 *   { kind: "library", codebase } (no slug).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beatForever } from "./heartbeat.mjs";
import { TUNNEL_CONNECTED, watchTunnel } from "./tunnel-state.mjs";

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
const what = kind === "prototype" ? { kind, codebase, slug } : { kind, codebase };
const tunnel = watchTunnel(runDir);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A run spec without a tunnel process (a library served on localhost
// only) must never beat: the site would load a hostname that does not
// exist, and the failed lookup is cached as "does not exist" for the
// zone's negative TTL. A crash-looping dev server must not claim
// liveness either.
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

// Serving that is not healthy stays silent. Serving whose tunnel cannot
// reach Cloudflare says so and keeps beating: that is the difference
// between "the address is dead" and "the laptop is gone".
beatForever(() => {
  if (!siblingsUp()) return null;
  return { ...what, tunnelConnected: tunnel.read().status === TUNNEL_CONNECTED };
});
