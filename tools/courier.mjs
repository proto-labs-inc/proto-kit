#!/usr/bin/env node
/**
 * The courier listener (MAA-130, amendment 2): the website→laptop
 * doorbell. Receives bearer-authed enumerated JSON commands on a local
 * port (exposed publicly via this laptop's courier tunnel, provisioned
 * by the site for { kind: "courier", courierId }),
 * validates them, and appends each ACCEPTED command as one JSON line to
 * <run-dir>/commands.jsonl — the durable feed the listening session
 * consumes (see skills/listen/ and
 * docs/harness-mechanics.md for why a file, not stdout: lines
 * emitted while no watch is armed would be lost, and the monitored
 * command is killed at watch end while this listener must keep its
 * port).
 *
 * That's the whole job: no spawning, no queue, no run tracking — the
 * session running the listen skill acts on commands inline.
 *
 * Command handling is transport-agnostic: handle() takes a parsed JSON
 * command however it arrived. courier-http.mjs is the current
 * transport; a WebSocket transport replaces that file only.
 *
 * Commands v1 (validated, then appended verbatim + envelope):
 *   { "run": "<prompt-name>", "briefId"?: "…" }
 *   { "status": true }
 *   { "restart-serving": "<slug>" | true }
 *
 * Usage: node courier.mjs <run-dir>     (reads <run-dir>/courier.json:
 *   { "codebase": "acme", "port": 5300, "secret": "…" })
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serveHttp } from "./courier-http.mjs";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node courier.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
const feed = join(runDir, "commands.jsonl");

function validated(cmd) {
  if (!cmd || typeof cmd !== "object") return null;
  if (typeof cmd.run === "string" && cmd.run.length > 0) {
    const out = { run: cmd.run };
    if (cmd.briefId !== undefined) {
      if (typeof cmd.briefId !== "string") return null;
      out.briefId = cmd.briefId;
    }
    return out;
  }
  if (cmd.status === true) return { status: true };
  const rs = cmd["restart-serving"];
  if (rs === true || (typeof rs === "string" && rs.length > 0)) {
    return { "restart-serving": rs };
  }
  return null;
}

// agentListening: the listening session's feed watch stamps
// watch-heartbeat.json in the run dir; a fresh stamp means someone is
// consuming commands. Local to this laptop: the feed watchers write
// the stamp every few seconds, and this is how old it may be before
// the watcher counts as gone.
const WATCH_STALE_MS = 15_000;
function agentState() {
  try {
    const beat = JSON.parse(readFileSync(join(runDir, "watch-heartbeat.json"), "utf8"));
    const age = Date.now() - Date.parse(beat.at);
    return { agentListening: age < WATCH_STALE_MS, lastSeenAt: beat.at };
  } catch {
    return { agentListening: false, lastSeenAt: null };
  }
}

export async function handle(cmd) {
  const accepted = validated(cmd);
  if (!accepted) {
    return {
      status: 400,
      body: { error: "unknown command; expected run | status | restart-serving" },
    };
  }
  const entry = { id: randomUUID().slice(0, 8), receivedAt: new Date().toISOString(), ...accepted };
  const line = JSON.stringify(entry);
  appendFileSync(feed, line + "\n");
  console.log(line); // audit trail in the supervisor's log
  if (accepted.status === true) {
    // Synchronous half of status: is anyone consuming this feed? The
    // site reads this to pick the Execute button's tier. The command
    // still lands in the feed so a listening agent can enrich
    // status.json with the slow half.
    return { status: 200, body: { ok: true, id: entry.id, ...agentState() } };
  }
  return { status: 202, body: { ok: true, id: entry.id } };
}

serveHttp({ port: config.port, secret: config.secret, handle }, () =>
  console.log(`courier listener for ${config.codebase} on 127.0.0.1:${config.port}`),
);

// Heartbeat to the cloud: how the site knows this laptop's courier is
// alive and whether an agent is consuming its feed. Couriers are per
// laptop, keyed by the cloud-minted courierId in courier.json; the
// beat's target is { kind: "courier", courierId, agentListening }. The
// app answers with its staleness window and the loop paces itself
// from that (heartbeat.mjs). Fail soft always: a beat that cannot be
// sent is a missed beat, never a crash.
//
// Nothing here says whether this laptop's tunnel is up (MAA-182). The
// site pushes commands through that tunnel, so on a network that blocks
// it a dispatch fails, and the site says so from the failure itself
// rather than from anything stored. That question disappears when the
// courier pulls its own work over HTTPS (MAA-200).
if (config.courierId) {
  const { beatForever } = await import("./heartbeat.mjs");
  beatForever(() => ({
    kind: "courier",
    courierId: config.courierId,
    agentListening: agentState().agentListening,
  }));
}
