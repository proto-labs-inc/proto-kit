#!/usr/bin/env node
/**
 * The courier (MAA-130): the website→laptop command daemon. Listens on a
 * local port (exposed publicly via the project's agent-<project> tunnel),
 * accepts enumerated JSON commands, and delivers agent work to ONE
 * persistent project agent — a single Claude Code session per project.
 * The first command starts it (`claude -p`) and captures the session ID
 * from the streamed JSON; every later command resumes it
 * (`--resume <session-id>`), so the agent keeps continuity across
 * commands, can spawn its own subagents, and the user can attach to the
 * same conversation from their terminal (`claude --resume <id>`).
 *
 * The daemon is doorbell + watchdog, not the brain: it parents each run,
 * tees the stream to a per-run log, persists the session ID, reports
 * start/finish/failure, and never wedges the queue — a resumed run that
 * dies without producing any events is treated as a broken session: the
 * break is recorded in session.json, the session is cleared, and the
 * command retries once on a fresh session.
 *
 * Command handling is transport-agnostic: handle() takes a parsed JSON
 * command however it arrived. courier-http.mjs is the current transport;
 * a WebSocket transport replaces that file only.
 *
 * Commands v1:
 *   { "run": "<prompt-name>", "briefId"?: "…" }  → queue for the project agent
 *   { "status": true }                            → runs + session + serving health
 *   { "restart-serving": "<slug>" | true }        → restart serving (one|all)
 *
 * Usage: node courier.mjs <run-dir>     (reads <run-dir>/courier.json)
 *
 * courier.json:
 *   { "project": "acme",
 *     "projectDir": "/abs/~/.proto/acme",
 *     "port": 5300,
 *     "secret": "…",
 *     "run": { "bin": "claude",
 *              "args": ["-p", "--output-format", "stream-json", "--verbose"],
 *              "resumeArgs": ["--resume", "{sessionId}"],
 *              "instruction": "run prompt {prompt} from the totypes MCP server" } }
 * The spawned command line is config, not code: argv is
 * [bin, ...args, ...resumeArgs (when a session exists), instruction] —
 * so the real MCP prompt wiring, and test stubs, are config edits.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { serveHttp } from "./courier-http.mjs";

const runDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node courier.mjs <run-dir>");
  process.exit(1);
}
const config = JSON.parse(readFileSync(join(runDir, "courier.json"), "utf8"));
const logsDir = join(runDir, "runs");
mkdirSync(logsDir, { recursive: true });

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- the project agent's session, persisted across daemon restarts ----
const sessionPath = join(runDir, "session.json");
let session;
try {
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
} catch {
  session = { sessionId: null, createdAt: null, runsCompleted: 0, breaks: [] };
}
const saveSession = () => writeFileSync(sessionPath, JSON.stringify(session, null, 2));

// ---- runs: one at a time, FIFO queue ----
const runs = []; // {id, prompt, briefId, instruction, state, retried?, ...}
let current = null;

function instructionFor(cmd) {
  let text = config.run.instruction.replaceAll("{prompt}", cmd.run);
  if (cmd.briefId) text += ` for brief ${cmd.briefId}`;
  return text;
}

function startNext() {
  if (current) return;
  const next = runs.find((r) => r.state === "queued");
  if (!next) return;
  current = next;
  next.state = "running";
  next.startedAt = new Date().toISOString();
  next.resumed = Boolean(session.sessionId);

  const argv = [
    ...config.run.args,
    ...(session.sessionId
      ? config.run.resumeArgs.map((a) => a.replaceAll("{sessionId}", session.sessionId))
      : []),
    next.instruction,
  ];
  console.log(`run ${next.id} start (${next.prompt})${next.resumed ? ` resuming ${session.sessionId}` : " fresh session"}`);
  const log = createWriteStream(join(logsDir, `${next.id}.log`), { flags: "a" });
  const child = spawn(config.run.bin, argv, {
    cwd: config.projectDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  next.pid = child.pid;
  child.stderr.pipe(log, { end: false });

  // Tee stdout to the log while watching the JSON stream for session_id
  // (both the stream-json init event and the json result carry it).
  let sawEvents = false;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    log.write(chunk);
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      try {
        const event = JSON.parse(line);
        sawEvents = true;
        if (typeof event.session_id === "string" && event.session_id !== session.sessionId) {
          session.sessionId = event.session_id;
          session.createdAt ??= new Date().toISOString();
          saveSession();
        }
      } catch {}
    }
  });

  child.on("exit", (code) => {
    log.end();
    next.endedAt = new Date().toISOString();
    next.exitCode = code;
    current = null;
    if (code === 0) {
      next.state = "done";
      session.runsCompleted += 1;
      saveSession();
      console.log(`run ${next.id} done`);
    } else if (next.resumed && !sawEvents && !next.retried) {
      // The session is corrupt/gone: note the break, retry once fresh.
      session.breaks.push({ at: next.endedAt, runId: next.id, sessionId: session.sessionId });
      session.sessionId = null;
      saveSession();
      next.state = "queued";
      next.retried = true;
      console.log(`run ${next.id} hit a broken session; retrying on a fresh one`);
    } else {
      next.state = "failed";
      console.log(`run ${next.id} FAILED (exit ${code})`);
    }
    startNext();
  });
  child.on("error", (err) => {
    log.end();
    next.state = "failed";
    next.endedAt = new Date().toISOString();
    current = null;
    console.log(`run ${next.id} FAILED to spawn: ${err.message}`);
    startNext();
  });
}

// ---- serving health: sibling run dirs under <project>/run/ ----
function servingState() {
  const parent = dirname(runDir);
  const out = [];
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || join(parent, entry.name) === runDir) continue;
    let state = null;
    try {
      state = JSON.parse(readFileSync(join(parent, entry.name, "state.json"), "utf8"));
    } catch {}
    const up = state ? alive(state.pid) : false;
    out.push({
      slug: entry.name,
      supervisor: up ? "up" : "down",
      processes: up
        ? Object.fromEntries(
            Object.entries(state.processes).map(([name, p]) => [
              name,
              { status: alive(p.pid) ? "up" : "down", restarts: p.restarts },
            ]),
          )
        : {},
    });
  }
  return out;
}

const superviseTool = fileURLToPath(new URL("./supervise.mjs", import.meta.url));
function restartServing(which) {
  const parent = dirname(runDir);
  const targets = servingState()
    .filter((s) => which === true || s.slug === which)
    .map((s) => join(parent, s.slug));
  for (const dir of targets) {
    spawn(process.execPath, [superviseTool, "stop", dir], { stdio: "ignore" }).on(
      "exit",
      () => setTimeout(() => spawn(process.execPath, [superviseTool, "start", dir], { stdio: "ignore" }), 500),
    );
  }
  return targets.length;
}

// ---- the transport-agnostic handler ----
export async function handle(cmd) {
  if (cmd && typeof cmd.run === "string" && cmd.run.length > 0) {
    const run = {
      id: randomUUID().slice(0, 8),
      prompt: cmd.run,
      briefId: cmd.briefId,
      instruction: instructionFor(cmd),
      state: "queued",
      queuedAt: new Date().toISOString(),
    };
    runs.push(run);
    startNext(); // ack does not wait on the run's outcome
    return {
      status: 202,
      body: { ok: true, runId: run.id, state: run.state, position: runs.filter((r) => r.state === "queued").length },
    };
  }
  if (cmd && cmd.status) {
    return {
      status: 200,
      body: {
        project: config.project,
        session: {
          id: session.sessionId,
          runsCompleted: session.runsCompleted,
          breaks: session.breaks.length,
        },
        current: current
          ? { id: current.id, prompt: current.prompt, startedAt: current.startedAt, resumed: current.resumed }
          : null,
        queue: runs.filter((r) => r.state === "queued").map((r) => ({ id: r.id, prompt: r.prompt })),
        recent: runs
          .filter((r) => r.state === "done" || r.state === "failed")
          .slice(-5)
          .map((r) => ({ id: r.id, prompt: r.prompt, state: r.state, exitCode: r.exitCode })),
        serving: servingState(),
      },
    };
  }
  if (cmd && cmd["restart-serving"]) {
    const count = restartServing(cmd["restart-serving"]);
    return { status: 202, body: { ok: true, restarting: count } };
  }
  return { status: 400, body: { error: "unknown command; expected run | status | restart-serving" } };
}

serveHttp({ port: config.port, secret: config.secret, handle }, () =>
  console.log(`courier for ${config.project} on 127.0.0.1:${config.port}`),
);
