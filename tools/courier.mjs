#!/usr/bin/env node
/**
 * The courier listener (MAA-130, amendment 2): the website→laptop
 * doorbell. Receives bearer-authed enumerated JSON commands on a local
 * port (exposed publicly via the product's agent-<product> tunnel),
 * validates them, and appends each ACCEPTED command as one JSON line to
 * <run-dir>/commands.jsonl — the durable feed the always-on product
 * agent consumes (see skills/product-agent/ and
 * docs/claude-code-mechanics.md for why a file, not stdout: lines
 * emitted while no watch is armed would be lost, and the monitored
 * command is killed at watch end while this listener must keep its
 * port).
 *
 * That's the whole job: no spawning, no queue, no run tracking — the
 * product agent acts on commands inline, in its own session.
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
 *   { "product": "acme", "port": 5300, "secret": "…" })
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
  return { status: 202, body: { ok: true, id: entry.id } };
}

serveHttp({ port: config.port, secret: config.secret, handle }, () =>
  console.log(`courier listener for ${config.product} on 127.0.0.1:${config.port}`),
);
