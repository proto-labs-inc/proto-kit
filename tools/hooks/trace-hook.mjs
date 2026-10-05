#!/usr/bin/env node
/**
 * Trace hook, for every harness: keeps ~/.proto/traces/<session>/ a
 * turn behind at most (see tools/trace.mjs).
 *
 *   end of a turn or session   Claude Code Stop / SubagentStop /
 *                              SessionEnd, Codex Stop / SessionEnd,
 *                              Cursor stop / sessionEnd: start
 *                              `trace.mjs sync` detached and return at
 *                              once, so the turn never waits on it.
 *   each tool call (Cursor)    Cursor's transcript has no times and no
 *                              tool output, so its postToolUse events
 *                              are kept beside it, in hooks.jsonl, for
 *                              the trace to take times and output from.
 *
 * Silent and fail soft. Cursor reads JSON back, so it gets `{}`.
 */
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TRACES = join(homedir(), ".proto", "traces");
let cursor = false;

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  cursor = "cursor_version" in input || "conversation_id" in input;
  const event = String(input.hook_event_name ?? process.argv[2] ?? "");
  const id = input.session_id ?? input.conversation_id ?? input.sessionId;
  const path = input.transcript_path ?? process.env.CURSOR_TRANSCRIPT_PATH;
  const harness = cursor ? "cursor" : String(path ?? "").includes("/.codex/") ? "codex" : "claude-code";

  if (cursor && /^(postToolUse|postToolUseFailure|afterShellExecution|afterMCPExecution)$/i.test(event) && id) {
    const dir = join(TRACES, String(id));
    // Only sessions already known to use Proto, or this call shows it.
    const proto = existsSync(join(dir, "meta.json")) || /proto:[a-z-]+|\/\.proto\/|proto-kit|plugins\/local\/proto\/|\/proto\/(tools|skills)\/|mcp__.*proto/i.test(JSON.stringify(input.tool_input ?? input.command ?? ""));
    if (proto) {
      mkdirSync(dir, { recursive: true });
      const output = input.tool_output ?? input.output ?? input.error ?? "";
      appendFileSync(join(dir, "hooks.jsonl"), JSON.stringify({ at: new Date().toISOString(), event, tool: input.tool_name ?? (event === "afterShellExecution" ? "Shell" : event === "afterMCPExecution" ? "MCP" : ""), input: input.tool_input ?? (input.command ? { command: input.command } : {}), output: String(typeof output === "string" ? output : JSON.stringify(output)).slice(0, 20000), ms: input.duration ?? input.duration_ms, error: /Failure$/.test(event) || undefined }) + "\n");
    }
  } else if (path && id) {
    const trace = fileURLToPath(new URL("../trace.mjs", import.meta.url));
    mkdirSync(TRACES, { recursive: true });
    const log = openSync(join(TRACES, "sync.log"), "a");
    const child = spawn(process.execPath, [trace, "sync", "--transcript", path, "--session", String(id), "--harness", harness, "--background"], { detached: true, stdio: ["ignore", log, log] });
    child.unref();
    closeSync(log);
  }
} catch {}
if (cursor) process.stdout.write("{}\n");
process.exit(0);
