#!/usr/bin/env node
/**
 * The courier listener (MAA-130, amendment 2): the website→laptop
 * doorbell. Receives enumerated JSON commands from the site's relay over
 * the WebSocket courier-relay.mjs holds open, validates them, and appends
 * each ACCEPTED command as one JSON line to <run-dir>/commands.jsonl,
 * the durable feed the listening session consumes (see skills/listen/
 * and docs/harness-mechanics.md for why a file, not stdout: lines
 * emitted while no watch is armed would be lost, and the monitored
 * command is killed at watch end while this listener must keep going).
 * Its bearer-authed HTTP port is local only (127.0.0.1), for checks on
 * this laptop; the secret in courier.json guards that port and nothing
 * else.
 *
 * That's the whole job: no spawning, no queue, no run tracking — the
 * session running the listen skill acts on commands inline.
 *
 * Command handling is transport-agnostic: handle() takes a parsed JSON
 * command however it arrived, from the relay or from the local port.
 *
 * Commands v1 (validated, then appended verbatim + envelope):
 *   { "run": "<prompt-name>", "briefId"?: "…" }
 *   { "run": "answer", "briefId", "questionId", "option" | "text" | "hold": true }
 *       a person's answer to a build's question (tools/questions.mjs)
 *   { "status": true }
 *   { "restart-serving": "<slug>" | true }
 *
 * Usage: node courier.mjs <run-dir>     (reads <run-dir>/courier.json:
 *   { "codebase": "acme", "port": 5300, "secret": "…", "courierId": "…",
 *     "relay": { "url": "…", "token": "…" } })
 */
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { serveHttp } from "./courier-http.mjs";
import { connectRelay, relayConfig } from "./courier-relay.mjs";
import { callTool, readConfig, targetFor } from "./mcp-call.mjs";
import { answerCommand } from "./questions.mjs";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node courier.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
const feed = join(runDir, "commands.jsonl");

function validated(cmd) {
  if (!cmd || typeof cmd !== "object") return null;
  // An answer carries the question it answers and what was said; the
  // build waiting on it needs every field, so it is checked whole.
  if (cmd.run === "answer") return answerCommand(cmd);
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
    // status.json with the slow half. relay says whether the site can
    // reach this courier at all.
    return { status: 200, body: { ok: true, id: entry.id, ...agentState(), relay: connection?.state() ?? "none" } };
  }
  return { status: 202, body: { ok: true, id: entry.id } };
}

serveHttp(
  {
    port: config.port,
    secret: config.secret,
    handle,
    health: async () => ({ ok: true, ...agentState(), relay: connection?.state() ?? "none" }),
  },
  () => console.log(`courier listener for ${config.codebase} on 127.0.0.1:${config.port}`),
);

// The relay: where the site's commands arrive. The connection is also
// the heartbeat (courier-relay.mjs), so nothing here beats to the site.
// A courier set up before the relay existed has no relay block, so it
// asks for one itself and keeps it in courier.json.
const ADDRESS_TIMEOUT_MS = 15_000;
async function relaySettings() {
  const known = relayConfig(config);
  if (known) return known;
  // A network that swallows packets would otherwise hold one attempt for
  // minutes; better to fail it and let the backoff below try again.
  const result = await callTool("register_courier", { courierId: config.courierId }, targetFor(readConfig(), { codebase: config.codebase }), {
    signal: AbortSignal.timeout(ADDRESS_TIMEOUT_MS),
  });
  const text = result?.content?.[0]?.text ?? "";
  if (result?.isError) throw new Error(text || "register_courier failed");
  const answer = JSON.parse(text || "{}");
  if (!answer.relayUrl || !answer.relayToken) throw new Error("the site sent no relay address");
  config.relay = { url: answer.relayUrl, token: answer.relayToken };
  // Other tools write this file while the courier runs (codex-thread.mjs
  // records the Codex thread here, and feed-queue.mjs reads it back), and
  // this fetch can retry for minutes, so the file is read again now and
  // only relay is set: the copy read at startup would erase what they
  // wrote. The relay token sits beside the secret, so the file stays the
  // owner's alone even when it was written before it held one.
  const path = join(runDir, "courier.json");
  const current = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...current, relay: config.relay }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return config.relay;
}

// Once connected, courier-relay.mjs reconnects on its own; this retry only
// covers not knowing where the relay is yet (offline, or the site down).
let connection = null;
if (config.courierId) {
  const startRelay = async (attempt = 0) => {
    try {
      const { url, token } = await relaySettings();
      connection = connectRelay({
        url,
        courierId: config.courierId,
        token,
        handle,
        listening: () => agentState().agentListening,
        log: (text) => console.log(text),
      });
    } catch (error) {
      const wait = Math.min(60_000, 5_000 * 2 ** attempt);
      console.log(`relay: could not get this courier's relay address (${error.message}); trying again in ${wait / 1000}s`);
      setTimeout(() => startRelay(attempt + 1), wait);
    }
  };
  startRelay();
}
