#!/usr/bin/env node
/**
 * Launches the always-on project agent for the supervisor. Keeps the
 * "resume where possible" knowledge out of the agent and out of
 * supervise.mjs: reads <run-dir>/session.json, starts the agent fresh
 * or with --resume <id>, captures the session id from the agent's own
 * JSON stream (the first stream event already carries session_id —
 * docs/claude-code-mechanics.md, "Session identity in headless runs"),
 * and persists it for the next launch. Exits with the agent's code, so
 * supervise's crash-restart gives resume-across-crashes for free.
 *
 * Usage: node agent-launch.mjs <run-dir>   (reads <run-dir>/courier.json)
 *
 * courier.json's agent block:
 *   "agent": { "bin": "claude",
 *              "args": ["-p", "--output-format", "stream-json", "--verbose",
 *                        "--allowed-tools=Bash,Monitor,Read,Skill"],
 *              "resumeArgs": ["--resume", "{sessionId}"],
 *              "instruction": "Load and follow the project-agent skill …",
 *              "resumeInstruction": "You were restarted; follow the
 *                project-agent skill's restart protocol …" }
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node agent-launch.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8")).agent;
const sessionPath = join(runDir, "session.json");

let session = { sessionId: null };
try {
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
} catch {}

const resuming = Boolean(session.sessionId);
const argv = [
  ...config.args,
  ...(resuming ? config.resumeArgs.map((a) => a.replaceAll("{sessionId}", session.sessionId)) : []),
  resuming ? (config.resumeInstruction ?? config.instruction) : config.instruction,
];
console.log(`agent ${resuming ? `resuming ${session.sessionId}` : "starting fresh"}`);

const child = spawn(config.bin, argv, { stdio: ["ignore", "pipe", "inherit"] });
let buffer = "";
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk); // the supervisor's log keeps the full stream
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    try {
      const event = JSON.parse(line);
      if (typeof event.session_id === "string" && event.session_id !== session.sessionId) {
        session.sessionId = event.session_id;
        writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      }
    } catch {}
  }
});
child.on("exit", (code) => process.exit(code ?? 1));
