/**
 * Reads an agent session's transcript into one shape, whichever harness
 * wrote it, and works out where its time went and where it struggled.
 * Used by trace.mjs; nothing here writes or sends anything.
 *
 *   readTrace(dir)   the session in ~/.proto/traces/<id>/ (or any folder
 *                    laid out the same way: transcript.jsonl plus
 *                    subagents/), as { session, agents, prompts,
 *                    requests, tools, errors, compactions }
 *   analyze(trace)   the numbers and the struggles, as a plain object
 *   reportMarkdown(trace, summary), chatMarkdown(trace)
 *
 * Time is partitioned, never double counted: every gap between two
 * consecutive records of one agent goes to exactly one bucket. A gap
 * with a tool call in flight is that tool's (the earliest started, when
 * several run at once); a gap that ends at a person's message is time
 * waiting on them; one that ends at a background notification is time
 * waiting on background work; any other gap is the model's.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const OUTPUT_KEEP = 4000;
const SLOW_TOOL_MS = 60_000;
const SLOW_MODEL_MS = 90_000;

// ---------------------------------------------------------------------
// Reading

function lines(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text : b.type === "image" ? "[image]" : ""))
    .join("\n");
}

/** Who a user-role message came from: the person, a background
 *  notification, or the harness talking to the model. */
function origin(text, record) {
  if (record?.isMeta || record?.isCompactSummary) return "harness";
  if (/^\s*<task-notification>|^\s*\[SYSTEM NOTIFICATION/.test(text)) return "background";
  if (/^\s*<(local-command-stdout|local-command-stderr|system-reminder)>/.test(text) && !/<command-name>/.test(text)) return "harness";
  if (/^\s*Caveat: The messages below/.test(text)) return "harness";
  return "person";
}

/** One Claude Code transcript file (the main session or one subagent). */
function readClaudeFile(path, agent, trace) {
  const records = lines(path);
  const open = new Map();
  const byRequest = new Map();
  let prev = null;
  for (const r of records) {
    const at = ms(r.timestamp);
    if (Number.isNaN(at)) continue;
    if (agent === "main" && !trace.session.cwd && r.cwd) {
      trace.session.cwd = r.cwd;
      trace.session.version = r.version;
    }
    if (r.type === "assistant" && r.message) {
      const key = r.requestId || r.message.id || r.uuid;
      let req = byRequest.get(key);
      if (!req) {
        req = { agent, id: key, start: prev ?? at, at, end: at, model: r.message.model, text: "", thinkingChars: 0, toolUses: 0, stop: null, usage: null };
        byRequest.set(key, req);
        trace.requests.push(req);
      }
      req.end = Math.max(req.end, at);
      if (r.message.usage) req.usage = r.message.usage;
      if (r.message.stop_reason) req.stop = r.message.stop_reason;
      if (!trace.session.model && r.message.model && !r.message.model.startsWith("<")) trace.session.model = r.message.model;
      for (const b of r.message.content ?? []) {
        if (b.type === "thinking") req.thinkingChars += (b.thinking ?? "").length;
        else if (b.type === "text") req.text += (req.text ? "\n" : "") + b.text;
        else if (b.type === "tool_use") {
          req.toolUses++;
          const tool = { agent, id: b.id, name: b.name, input: b.input ?? {}, at, end: null, ms: null, error: false, output: "", outputBytes: 0, request: key };
          open.set(b.id, tool);
          trace.tools.push(tool);
        }
      }
    } else if (r.type === "user" && r.message) {
      const content = r.message.content;
      const results = Array.isArray(content) ? content.filter((b) => b.type === "tool_result") : [];
      for (const b of results) {
        const tool = open.get(b.tool_use_id);
        if (!tool) continue;
        open.delete(b.tool_use_id);
        const out = textOf(b.content);
        tool.end = at;
        tool.ms = at - tool.at;
        tool.error = Boolean(b.is_error);
        tool.outputBytes = out.length;
        tool.output = out.length > OUTPUT_KEEP ? out.slice(0, OUTPUT_KEEP / 2) + `\n… [${out.length - OUTPUT_KEEP} chars cut] …\n` + out.slice(-OUTPUT_KEEP / 2) : out;
        const res = r.toolUseResult;
        if (res && typeof res === "object") {
          if (res.interrupted) tool.interrupted = true;
          if (res.agentId) tool.subagent = res.agentId;
        }
        if (/^The user doesn't want to proceed|^User rejected|Permission to use .* (was )?denied/i.test(out)) tool.rejected = true;
      }
      if (!results.length) {
        const text = textOf(content);
        if (text.trim()) {
          const from = origin(text, r);
          if (/\[Request interrupted by user/.test(text)) trace.errors.push({ agent, at, kind: "interrupted", text: "Interrupted by the person" });
          trace.prompts.push({ agent, at, from, text });
        }
      }
    } else if (r.type === "attachment" && r.attachment?.type === "queued_command") {
      // A message that arrived while the agent worked: the person's, or a
      // background notification or subagent hand-back.
      const q = r.attachment;
      const text = textOf(q.prompt);
      if (!text.trim()) continue;
      trace.prompts.push({ agent, at, from: q.origin?.kind === "human" || q.humanTurn ? "person" : "background", text, queued: true });
    } else if (r.type === "system") {
      if (r.subtype === "api_error") trace.errors.push({ agent, at, kind: "api_error", text: String(r.error?.message ?? r.error?.error?.message ?? JSON.stringify(r.error ?? {})).slice(0, 300), attempt: r.retryAttempt, max: r.maxRetries });
      if (r.subtype === "compact_boundary") trace.compactions.push({ agent, at, trigger: r.compactMetadata?.trigger, preTokens: r.compactMetadata?.preTokens });
    } else if (r.type === "summary" || r.isCompactSummary) {
      trace.compactions.push({ agent, at, trigger: "summary" });
    } else continue;
    prev = at;
    const a = trace.agents.find((x) => x.id === agent);
    a.firstAt = Math.min(a.firstAt ?? at, at);
    a.lastAt = Math.max(a.lastAt ?? at, at);
    a.times.push(at);
  }
  for (const tool of open.values()) tool.unfinished = true;
}

/** One Codex rollout. The format is Codex's own and not promised to be
 *  stable; this reads what it has written so far and skips the rest. */
function readCodexFile(path, agent, trace) {
  const open = new Map();
  let req = null;
  let prev = null;
  for (const r of lines(path)) {
    const at = ms(r.timestamp);
    if (Number.isNaN(at)) continue;
    const p = r.payload ?? {};
    if (r.type === "session_meta" && agent === "main") {
      trace.session.cwd = p.cwd;
      trace.session.version = p.cli_version;
    } else if (r.type === "turn_context") {
      if (!trace.session.model) trace.session.model = p.model;
    } else if (r.type === "response_item") {
      if (p.type === "message" && p.role === "user") {
        const text = textOf((p.content ?? []).map((c) => ({ type: "text", text: c.text ?? "" })));
        if (/^<(environment_context|user_instructions|permissions)/.test(text.trim())) continue;
        trace.prompts.push({ agent, at, from: origin(text), text });
        req = null;
      } else if (["message", "reasoning", "function_call", "custom_tool_call", "local_shell_call"].includes(p.type)) {
        if (!req) {
          req = { agent, id: `${agent}:${at}`, start: prev ?? at, at, end: at, text: "", thinkingChars: 0, toolUses: 0, stop: null, usage: null };
          trace.requests.push(req);
        }
        req.end = at;
        if (p.type === "message") req.text += textOf((p.content ?? []).map((c) => ({ type: "text", text: c.text ?? "" })));
        if (p.type === "reasoning") req.thinkingChars += JSON.stringify(p.summary ?? "").length;
        if (p.type !== "message" && p.type !== "reasoning") {
          let input = p.arguments ?? p.input ?? p.action ?? {};
          if (typeof input === "string") {
            try {
              input = JSON.parse(input);
            } catch {
              input = { input };
            }
          }
          if (Array.isArray(input.command)) input = { ...input, command: input.command.join(" ") };
          const tool = { agent, id: p.call_id ?? p.id, name: p.name ?? p.type, input, at, end: null, ms: null, error: false, output: "", outputBytes: 0, request: req.id };
          req.toolUses++;
          open.set(tool.id, tool);
          trace.tools.push(tool);
        }
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const tool = open.get(p.call_id);
        if (tool) {
          open.delete(p.call_id);
          const out = typeof p.output === "string" ? p.output : JSON.stringify(p.output);
          tool.end = at;
          tool.ms = at - tool.at;
          tool.outputBytes = out.length;
          tool.output = out.slice(0, OUTPUT_KEEP);
          tool.error = /"exit_code":\s*[1-9]|Process exited with code [1-9]|^error/i.test(out);
        }
        req = null;
      }
    } else if (r.type === "event_msg") {
      if (p.type === "token_count" && p.info?.last_token_usage && req) {
        const u = p.info.last_token_usage;
        req.usage = { input_tokens: (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0), cache_read_input_tokens: u.cached_input_tokens ?? 0, output_tokens: u.output_tokens ?? 0 };
      }
      if (p.type === "error" || p.type === "stream_error") trace.errors.push({ agent, at, kind: "api_error", text: String(p.message ?? "").slice(0, 300) });
      if (p.type === "turn_aborted") trace.errors.push({ agent, at, kind: "interrupted", text: "Turn aborted" });
      if (p.type === "context_compacted") trace.compactions.push({ agent, at, trigger: "auto" });
    } else if (r.type === "compacted") {
      trace.compactions.push({ agent, at, trigger: "auto" });
    } else continue;
    prev = at;
    const a = trace.agents.find((x) => x.id === agent);
    a.firstAt = Math.min(a.firstAt ?? at, at);
    a.lastAt = Math.max(a.lastAt ?? at, at);
    a.times.push(at);
  }
  for (const tool of open.values()) tool.unfinished = true;
}

/** A Cursor transcript: messages in order, with no times and no tool
 *  output. Times and output come from the postToolUse events the trace
 *  hook kept in hooks.jsonl, matched to the tool calls in order; a
 *  message takes the time of the step next to it. Without that file
 *  the session is laid out a second per record and marked untimed. */
function readCursorFile(path, agent, trace) {
  const events = lines(join(trace.dir, "hooks.jsonl"));
  const records = lines(path);
  let e = 0;
  let clockAt = events.length ? ms(events[0].at) - 1000 : 0;
  if (!events.length) trace.session.untimed = true;
  const pending = [];
  const a = trace.agents.find((x) => x.id === agent);
  const stamp = (at) => {
    a.firstAt = Math.min(a.firstAt ?? at, at);
    a.lastAt = Math.max(a.lastAt ?? at, at);
    a.times.push(at);
  };
  let req = null;
  for (const r of records) {
    const role = r.role ?? r.message?.role;
    const content = r.message?.content ?? r.content;
    if (role === "user") {
      const text = textOf(Array.isArray(content) ? content.filter((b) => b.type === "text") : content).replace(/^<user_query>\s*|\s*<\/user_query>$/g, "");
      clockAt += events.length ? 1 : 1000;
      if (text.trim()) {
        const p = { agent, at: clockAt, from: origin(text), text };
        trace.prompts.push(p);
        pending.push(p);
        stamp(clockAt);
      }
      req = null;
    } else if (role === "assistant") {
      for (const b of Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }]) {
        if (!req) {
          req = { agent, id: `${agent}:${trace.requests.length}`, start: clockAt, at: clockAt, end: clockAt, text: "", thinkingChars: 0, toolUses: 0, stop: null, usage: null };
          trace.requests.push(req);
        }
        if (b.type === "text") req.text += (req.text ? "\n" : "") + b.text;
        if (b.type === "tool_use") {
          const ev = events[e++];
          const end = ev ? ms(ev.at) : clockAt + 1000;
          const took = ev?.ms ?? null;
          const at = took != null ? end - took : Math.max(clockAt, end - 1);
          for (const p of pending.splice(0)) p.at = Math.min(p.at, at - 1);
          const out = ev?.output ?? "";
          trace.tools.push({ agent, id: `${agent}:t${trace.tools.length}`, name: b.name, input: b.input ?? {}, at, end, ms: ev ? end - at : null, error: Boolean(ev?.error) || /^(Error|error:)|exit code [1-9]/i.test(out), output: out.slice(0, OUTPUT_KEEP), outputBytes: out.length, request: req.id });
          req.toolUses++;
          req.end = at;
          stamp(at);
          stamp(end);
          clockAt = end;
          req = null;
        }
      }
      if (req) {
        clockAt += events.length ? 1 : 1000;
        req.end = clockAt;
        stamp(clockAt);
      }
    }
  }
}

/** A session from its trace folder. */
export function readTrace(dir) {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {}
  const harness = meta.harness ?? "claude-code";
  const trace = { dir, session: { id: meta.sessionId ?? basename(dir), harness, model: null, cwd: null, version: null }, meta, agents: [], prompts: [], requests: [], tools: [], errors: [], compactions: [] };
  const read = harness === "codex" ? readCodexFile : harness === "cursor" ? readCursorFile : readClaudeFile;
  trace.agents.push({ id: "main", type: "main", description: "Main session", times: [] });
  read(join(dir, "transcript.jsonl"), "main", trace);
  const subDir = join(dir, "subagents");
  if (existsSync(subDir)) {
    for (const name of readdirSync(subDir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const id = harness === "codex" ? (/-([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1] ?? name) : name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      let m = {};
      try {
        m = JSON.parse(readFileSync(join(subDir, name.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      } catch {}
      trace.agents.push({ id, type: m.agentType ?? "subagent", description: m.description ?? "", parentToolUseId: m.toolUseId, times: [] });
      read(join(subDir, name), id, trace);
    }
  }
  trace.agents = trace.agents.filter((a) => a.times.length);
  // A subagent's messages come from the agent that started it.
  for (const p of trace.prompts) if (p.agent !== "main" && p.from === "person") p.from = "parent";
  trace.tools.sort((a, b) => a.at - b.at);
  trace.tools.forEach((t, i) => (t.n = i + 1));
  trace.requests.sort((a, b) => a.at - b.at);
  trace.prompts.sort((a, b) => a.at - b.at);
  for (const t of trace.tools) {
    t.label = labelOf(t);
    t.group = groupOf(t);
    // Polling right after asking the person to do something is waiting
    // on them, however busy it looks.
    if (t.group === "Bash (sleep/poll)") {
      const said = trace.requests.filter((r) => r.agent === t.agent && r.end <= t.at && r.text.trim()).at(-1)?.text ?? "";
      if (ASKED_PERSON.test(said.slice(-600))) t.group = "waiting on the person (polling)";
    }
    const out = t.output ?? "";
    if (/denied by the Claude Code auto mode classifier|Permission to use .* has been denied|was blocked by|requires approval/i.test(out)) {
      t.rejected = true;
      if (/rest of this (conversation|session)/i.test(out)) t.blockedForGood = true;
    }
    if (/did not complete within its \d+s timeout|timed out after \d+/i.test(out)) t.timedOut = true;
  }
  const all = trace.agents.flatMap((a) => [a.firstAt, a.lastAt]);
  trace.session.firstAt = Math.min(...all);
  trace.session.lastAt = Math.max(...all);
  return trace;
}

// ---------------------------------------------------------------------
// Naming a step

/** A segment that runs a kit tool: `node [flags] …/tools/<x>.mjs [sub]`,
 *  after any `cd …`, `VAR=…` or `export …` before it. */
const PROTO_SCRIPT = /^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*node\s+(?:--?[a-z-]+(?:=\S+)?\s+)*["']?(?:[^\s"']*\/)?tools\/([a-z0-9-]+)\.mjs["']?(?:\s+([a-z][a-z-]*)(?=\s|$))?/;

/** A shell command's top-level segments, split on ; && || | and lines;
 *  heredoc bodies and quoted text are left out, so a script that only
 *  mentions a tool is not taken for running it. */
function segments(cmd) {
  const body = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, "").replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (q) => (/^["'][^\s]*tools\/[a-z0-9-]+\.mjs["']$/.test(q) ? q : '""'));
  return body.split(/\s*(?:;|&&|\|\||\||\n)\s*/).map((x) => x.trim()).filter(Boolean);
}
/** What an agent says when it hands the next move to the person. */
const ASKED_PERSON = /\b(paste|once you(?:'ve| have)?|when you(?:'ve| have)?|let me know|waiting (?:for|on) you|you(?:'ll)? need to|please (?:add|paste|log ?in|sign ?in|approve|run|click|open)|can you (?:add|paste|log ?in|sign ?in|run|click|open))\b/i;
/** An agent saying it hit a problem, in its own words. */
const NOTED = /\b(work(?:ed|ing)? around|workaround|(?:a|the|kit|this) bug\b|broken|(?:does|did|is)n['’]t work|not working|refus(?:es|ed) (?:to|the)|is wrong|was wrong|wrong (?:file|page|image|path|value)|unexpected(?:ly)?|contradicts|not allowed|stale|silently)\b/i;
/** Tools whose time is the person's, not the agent's. */
const ASKS_PERSON = new Set(["AskUserQuestion", "ExitPlanMode", "request_user_input"]);

/** How long a command means to sleep, in total, if it runs every
 *  iteration of its loop: `for i in $(seq 1 20)` / `for i in 1 2 3` /
 *  `while` (counted once) times its `sleep N`. */
function sleepsOf(cmd) {
  const sleeps = [...cmd.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)/g)].reduce((n, m) => n + Number(m[1]) * 1000, 0);
  return sleeps * loopCount(cmd);
}

function loopCount(cmd) {
  const seq = /for\s+\w+\s+in\s+\$\(seq\s+(?:(\d+)\s+)?(\d+)\)/.exec(cmd);
  if (seq) return Number(seq[2]) - Number(seq[1] ?? 1) + 1;
  const list = /for\s+\w+\s+in\s+((?:\d+\s+){1,200}\d+)\s*;/.exec(cmd);
  if (list) return list[1].trim().split(/\s+/).length;
  return 1;
}

/** The command a step ran, unwrapped from Codex's `bash -lc '…'`. */
function commandOf(t) {
  const cmd = String(t.input.command ?? t.input.cmd ?? "");
  const m = /^(?:\/bin\/)?(?:ba|z)?sh\s+-l?c\s+([\s\S]*)$/.exec(cmd.trim());
  if (!m) return cmd;
  const inner = m[1].trim();
  return /^(['"])[\s\S]*\1$/.test(inner) ? inner.slice(1, -1) : inner;
}

/** What a step did, in one line a person can scan. */
export function labelOf(t) {
  const i = t.input ?? {};
  if (t.name === "Bash" || t.name === "shell" || t.name === "exec_command" || t.name === "local_shell_call") return commandOf(t).replace(/\s+/g, " ").slice(0, 160);
  if (t.name === "Skill") return `skill ${i.skill}${i.args ? " " + String(i.args).slice(0, 60) : ""}`;
  if (t.name === "Agent" || t.name === "Task") return `${i.subagent_type ?? "agent"}: ${i.description ?? ""}`;
  if (i.file_path) return String(i.file_path).replace(/^\/Users\/[^/]+/, "~");
  if (i.pattern) return `${i.pattern}${i.path ? " in " + String(i.path).replace(/^\/Users\/[^/]+/, "~") : ""}`;
  if (i.url) return String(i.url);
  return JSON.stringify(i).slice(0, 160);
}

/** The bucket a step's time goes into: a Proto script by name, a Proto
 *  MCP tool, a skill, or the harness tool. */
export function groupOf(t) {
  if (ASKS_PERSON.has(t.name)) return "waiting on the person";
  if (t.name.startsWith("mcp__plugin_proto_")) return `proto mcp ${t.name.replace(/^mcp__plugin_proto_proto__/, "")}`;
  const cmd = commandOf(t);
  if (cmd) {
    const parts = segments(cmd).filter((x) => !/^(cd|export|source|set)\b/.test(x));
    const runs = [...new Set(parts.map((x) => PROTO_SCRIPT.exec(x)).filter(Boolean).map((m) => `${m[1]}${m[2] ? " " + m[2] : ""}`))];
    if (runs.length) return `proto ${runs.slice(0, 3).join(" + ")}${runs.length > 3 ? " + …" : ""}`;
    if (sleepsOf(cmd) >= 5000) return "Bash (sleep/poll)";
  }
  if (t.name.startsWith("mcp__")) return t.name.replace(/^mcp__(plugin_)?/, "mcp ").replace(/__/g, " ");
  return t.name;
}

// ---------------------------------------------------------------------
// Analysis

const fmt = (n) => (n == null || Number.isNaN(n) ? "–" : n >= 3600e3 ? `${(n / 3600e3).toFixed(1)}h` : n >= 60e3 ? `${Math.floor(n / 60e3)}m${String(Math.round((n % 60e3) / 1e3)).padStart(2, "0")}s` : `${(n / 1e3).toFixed(1)}s`);
export const duration = fmt;

/** Split one agent's wall clock into model, each tool group, the person
 *  and background work. */
function partition(trace, agentId, since = -Infinity, until = Infinity) {
  const tools = trace.tools.filter((t) => t.agent === agentId);
  const promptsAt = new Map(trace.prompts.filter((p) => p.agent === agentId).map((p) => [p.at, p.from]));
  const agent = trace.agents.find((a) => a.id === agentId);
  const times = [...new Set(agent.times)].sort((a, b) => a - b);
  const buckets = {};
  const add = (k, v) => (buckets[k] = (buckets[k] ?? 0) + v);
  for (let i = 1; i < times.length; i++) {
    const a = times[i - 1];
    const b = times[i];
    if (a < since || b > until) continue;
    const gap = b - a;
    if (gap <= 0) continue;
    const inFlight = tools.filter((t) => t.at <= a && (t.end ?? Infinity) >= b);
    if (inFlight.length) {
      add(inFlight[0].group, gap);
      continue;
    }
    const from = promptsAt.get(b);
    if (from === "person") add("waiting on the person", gap);
    else if (from === "background") add("waiting on background work", gap);
    else add("model (thinking + writing)", gap);
  }
  return buckets;
}

const contextOf = (u) => (u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0);

function normalized(t) {
  const cmd = commandOf(t);
  if (cmd) return `${t.name}:${cmd.replace(/\s+/g, " ").replace(/\d{3,}/g, "N").trim().slice(0, 200)}`;
  return `${t.name}:${JSON.stringify(t.input).slice(0, 200)}`;
}

/** The numbers and the struggles. Every struggle names the steps (by
 *  number) that show it, so `trace.mjs show` can open them. */
export function analyze(trace) {
  const s = trace.session;
  const main = trace.agents.find((a) => a.id === "main") ?? trace.agents[0];
  const buckets = partition(trace, main.id);
  const wall = s.lastAt - s.firstAt;
  const idle = Object.entries(buckets).filter(([k]) => k.startsWith("waiting on the person")).reduce((n, [, v]) => n + v, 0);
  const active = wall - idle;

  // Every agent's own time, so subagent work shows even when the main
  // session was only waiting on it.
  const agents = trace.agents.map((a) => {
    const tools = trace.tools.filter((t) => t.agent === a.id);
    const reqs = trace.requests.filter((r) => r.agent === a.id);
    return {
      id: a.id,
      type: a.type,
      description: a.description,
      wallMs: a.lastAt - a.firstAt,
      toolCalls: tools.length,
      errors: tools.filter((t) => t.error).length,
      outputTokens: reqs.reduce((n, r) => n + (r.usage?.output_tokens ?? 0), 0),
      peakContext: Math.max(0, ...reqs.map((r) => contextOf(r.usage))),
      // Its last words: whether it did the job, in its own report.
      ended: reqs.filter((r) => r.text.trim()).at(-1)?.text.replace(/\s+/g, " ").trim().slice(0, 240) ?? "",
      buckets: partition(trace, a.id),
    };
  });

  const allBuckets = {};
  for (const a of agents) for (const [k, v] of Object.entries(a.buckets)) if (!k.startsWith("waiting")) allBuckets[k] = (allBuckets[k] ?? 0) + v;

  // Tool groups: calls, errors and summed duration across agents.
  const groups = {};
  for (const t of trace.tools) {
    const g = (groups[t.group] ??= { group: t.group, calls: 0, errors: 0, ms: 0, maxMs: 0 });
    g.calls++;
    if (t.error) g.errors++;
    g.ms += t.ms ?? 0;
    g.maxMs = Math.max(g.maxMs, t.ms ?? 0);
  }

  // Phases: the stretch between one skill start (or person's message)
  // and the next, on the main session.
  const marks = [
    ...trace.prompts.filter((p) => p.agent === main.id && p.from === "person").map((p) => ({ at: p.at, label: `person: ${promptLine(p.text)}` })),
    ...trace.tools.filter((t) => t.agent === main.id && t.name === "Skill").map((t) => ({ at: t.at, label: `skill ${t.input.skill}` })),
    // A skill read from its file (Codex, Cursor, or an agent told to)
    // starts a phase too, once per skill.
    ...[...new Map(trace.tools.filter((t) => t.agent === main.id && t.name !== "Skill").map((t) => [/skills\/([a-z0-9-]+)\/SKILL\.md/.exec(`${t.input.file_path ?? ""} ${commandOf(t)}`)?.[1], t]).filter(([k]) => k).reverse()).entries()].map(([k, t]) => ({ at: t.at, label: `skill ${k} (read)` })),
  ].sort((a, b) => a.at - b.at);
  const phases = marks.map((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].at : s.lastAt;
    const tools = trace.tools.filter((t) => t.at >= m.at && t.at < end);
    const waiting = Object.entries(partition(trace, main.id, m.at, end)).filter(([k]) => k.startsWith("waiting on the person")).reduce((n, [, v]) => n + v, 0);
    return { label: m.label, at: m.at, ms: end - m.at, workingMs: end - m.at - waiting, toolCalls: tools.length, errors: tools.filter((t) => t.error).length };
  });

  const struggles = [];
  const flag = (severity, kind, title, steps, detail, costMs = 0) => struggles.push({ severity, kind, title, steps: steps.map((t) => t.n), detail, costMs });

  // Failing tool calls, by group.
  for (const g of Object.values(groups)) {
    if (g.group.startsWith("waiting")) continue;
    if (g.errors >= 2 || (g.errors >= 1 && g.group.startsWith("proto"))) {
      const failed = trace.tools.filter((t) => t.group === g.group && t.error);
      flag(g.errors >= 4 && g.errors / g.calls >= 0.2 ? "high" : g.errors / g.calls >= 0.1 || g.group.startsWith("proto") ? "medium" : "low", "errors", `${g.group} failed ${g.errors} of ${g.calls} times`, failed, failed.slice(0, 3).map((t) => errorLine(t.output)).join(" | "), failed.reduce((n, t) => n + (t.ms ?? 0), 0));
    }
  }
  // Runs of consecutive failures on one agent.
  for (const a of trace.agents) {
    let run = [];
    const tools = trace.tools.filter((t) => t.agent === a.id);
    for (const t of [...tools, { error: false }]) {
      if (t.error) run.push(t);
      else {
        if (run.length >= 3) flag("high", "error-streak", `${run.length} failures in a row${a.id === "main" ? "" : ` in ${a.type}`}`, run, run.map((x) => x.label.slice(0, 60)).join(" → "), run.at(-1).end - run[0].at);
        run = [];
      }
    }
  }
  // The same call made again and again: a loop when it keeps failing,
  // or when it comes back to back with nothing between (a screenshot
  // taken after each click is work, not a loop).
  // Calls more than five minutes apart start a new cluster: the same
  // screenshot an hour later is new work.
  const repeats = new Map();
  for (const a of trace.agents) {
    const tools = trace.tools.filter((t) => t.agent === a.id && !["Read", "TodoWrite", "TaskUpdate"].includes(t.name) && !/"action":"screenshot"|take_screenshot/.test(`${t.name}${JSON.stringify(t.input)}`));
    tools.forEach((t, i) => {
      const base = `${a.id}|${normalized(t)}`;
      let r = repeats.get(base);
      if (r && t.at - r.list.at(-1).at > 5 * 60e3) {
        repeats.set(`${base}|${t.at}`, r);
        repeats.delete(base);
        r = null;
      }
      r ??= repeats.set(base, { list: [], run: 0, best: 0, last: -2 }).get(base);
      r.run = r.last === i - 1 ? r.run + 1 : 1;
      r.best = Math.max(r.best, r.run);
      r.last = i;
      r.list.push(t);
    });
  }
  for (const { list, best } of repeats.values()) {
    const failed = list.filter((t) => t.error).length;
    if (failed >= 2 || best >= 3) flag(failed >= 3 || best >= 5 ? "high" : "medium", "repeat", `Same ${list[0].name} call ${list.length} times${best >= 3 ? ` (${best} back to back)` : ""}: ${list[0].label.slice(0, 80)}`, list, `${failed} of them failed`, list.reduce((n, t) => n + (t.ms ?? 0), 0));
  }
  // Re-reading one file.
  const reads = new Map();
  const edits = new Map();
  for (const t of trace.tools) {
    const f = t.input.file_path;
    if (!f) continue;
    const map = t.name === "Read" ? reads : ["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(t.name) ? edits : null;
    if (map) (map.get(f) ?? map.set(f, []).get(f)).push(t);
  }
  for (const [f, list] of reads) if (list.length >= 4) flag("low", "reread", `Read ${f.replace(/^\/Users\/[^/]+/, "~")} ${list.length} times`, list, "", 0);
  for (const [f, list] of edits) if (list.length >= 6) flag(list.length >= 12 ? "medium" : "low", "churn", `Edited ${f.replace(/^\/Users\/[^/]+/, "~")} ${list.length} times`, list, `${list.filter((t) => t.error).length} edits failed`, 0);
  // Slow steps.
  const slow = trace.tools.filter((t) => (t.ms ?? 0) >= SLOW_TOOL_MS && t.name !== "Agent" && t.name !== "Task" && !t.group.startsWith("waiting"));
  for (const t of slow.sort((a, b) => b.ms - a.ms).slice(0, 8)) flag(t.ms >= 5 * SLOW_TOOL_MS ? "high" : "medium", "slow", `${fmt(t.ms)} on ${t.group}: ${t.label.slice(0, 80)}`, [t], firstLine(t.output), t.ms);
  // A poll that ran every iteration never saw what it waited for.
  for (const t of trace.tools.filter((x) => x.group.includes("poll") && loopCount(commandOf(x)) > 1)) {
    const planned = sleepsOf(commandOf(t));
    if (t.ms >= 0.9 * planned || t.timedOut) flag("high", "poll-cap", `Poll ran to its limit (${loopCount(commandOf(t))} rounds, ${fmt(t.ms)}): its exit condition never matched?`, [t], lastLines(t.output), t.ms);
  }
  for (const t of trace.tools.filter((x) => x.timedOut && !x.group.includes("poll"))) flag("medium", "timeout", `${t.group} hit the tool's time limit after ${fmt(t.ms)}: ${t.label.slice(0, 70)}`, [t], firstLine(t.output), t.ms);
  // Polling.
  const sleeps = trace.tools.filter((t) => t.group === "Bash (sleep/poll)" && (t.ms ?? 0) >= 1000);
  if (sleeps.length >= 3) flag("medium", "polling", `Polled with sleep ${sleeps.length} times`, sleeps, "", sleeps.reduce((n, t) => n + (t.ms ?? 0), 0));
  // Long model turns.
  for (const r of trace.requests) {
    const t = r.end - r.start;
    // A long turn that wrote a lot at a normal rate is writing, not stuck.
    const rate = (r.usage?.output_tokens ?? 0) / (t / 1000);
    if (t >= SLOW_MODEL_MS && rate < 40) {
      const next = trace.tools.find((x) => x.request === r.id);
      struggles.push({ severity: t >= 3 * SLOW_MODEL_MS ? "medium" : "low", kind: "slow-model", title: `Model took ${fmt(t)} before ${next ? `step ${next.n} (${next.label.slice(0, 50)})` : "replying"}`, steps: next ? [next.n] : [], detail: `${r.usage?.output_tokens ?? "?"} output tokens (${Math.round(rate)}/s)`, costMs: t });
    }
  }
  // Interruptions, rejections, API errors, compactions, unfinished.
  const rejected = trace.tools.filter((t) => t.rejected || t.interrupted);
  if (rejected.length) flag(rejected.some((t) => t.blockedForGood) ? "high" : "medium", "rejected", `${rejected.length} tool calls rejected or interrupted`, rejected, rejected.slice(0, 3).map((t) => t.label.slice(0, 60)).join(" | "));
  for (const e of trace.errors) struggles.push({ severity: e.kind === "interrupted" ? "medium" : "low", kind: e.kind, title: e.kind === "interrupted" ? `The person interrupted at ${clock(e.at)}` : `API error at ${clock(e.at)} (attempt ${e.attempt ?? "?"}/${e.max ?? "?"})`, steps: [], detail: e.text, costMs: 0 });
  for (const c of trace.compactions) struggles.push({ severity: "medium", kind: "compaction", title: `Context compacted (${c.trigger ?? "?"}) at ${clock(c.at)}`, steps: [], detail: c.preTokens ? `${c.preTokens} tokens before` : "", costMs: 0 });
  // What the agents themselves said went wrong: the kit bugs that exit 0
  // (a wrong file saved, a step skipped) show only here.
  const noted = [];
  for (const r of trace.requests) {
    for (const sentence of r.text.split(/(?<=[.!?])\s+|\n+/)) {
      if (!NOTED.test(sentence) || sentence.length < 25) continue;
      const next = trace.tools.find((t) => t.agent === r.agent && t.at >= r.at);
      noted.push({ agent: r.agent, at: r.end, step: next?.n, text: sentence.trim().slice(0, 280) });
    }
  }
  if (noted.length) struggles.push({ severity: noted.length >= 5 ? "medium" : "low", kind: "agent-noted", title: `The agents said something was wrong ${noted.length} times (see "What the agents noticed")`, steps: [...new Set(noted.map((x) => x.step).filter(Boolean))].slice(0, 12), detail: noted.slice(0, 2).map((x) => x.text).join(" | "), costMs: 0 });
  // Subagents that came back without doing their job, by their own word.
  const gaveUp = agents.filter((g) => g.id !== "main" && /\b(restored|skipped|could[- ]not|couldn['’]t|exhausted|out of (checks|budget)|no match|did not (achieve|match)|unable to|gave up|blocked)\b/i.test(g.ended));
  if (gaveUp.length) struggles.push({ severity: gaveUp.length >= 3 ? "high" : "medium", kind: "subagents-gave-up", title: `${gaveUp.length} of ${agents.length - 1} subagents came back without finishing (${[...new Set(gaveUp.map((g) => g.type))].join(", ")})`, steps: trace.tools.filter((t) => gaveUp.some((g) => t.subagent === g.id)).map((t) => t.n), detail: gaveUp.slice(0, 2).map((g) => `${g.description}: ${g.ended.slice(0, 120)}`).join(" | "), costMs: gaveUp.reduce((n, g) => n + g.wallMs, 0) });
  const unfinished = trace.tools.filter((t) => t.unfinished);
  if (unfinished.length) flag("medium", "unfinished", `${unfinished.length} tool calls never returned`, unfinished, unfinished.map((t) => t.label.slice(0, 60)).join(" | "));
  // Peak context.
  const peak = Math.max(0, ...trace.requests.map((r) => contextOf(r.usage)));
  if (peak > 150_000) flag(peak > 400_000 ? "medium" : "low", "context", `Context reached ${Math.round(peak / 1000)}k tokens`, [], "Large contexts are slower and costlier per turn");
  const big = trace.tools.filter((t) => t.outputBytes > 40_000);
  if (big.length) flag("low", "big-output", `${big.length} tool results over 40 KB`, big, big.slice(0, 3).map((t) => `${t.label.slice(0, 50)} (${Math.round(t.outputBytes / 1000)} KB)`).join(" | "));

  // One step, one flag: a poll that hit its limit is not also "slow".
  const capped = new Set(struggles.filter((x) => x.kind === "poll-cap" || x.kind === "timeout").flatMap((x) => x.steps));
  for (let i = struggles.length - 1; i >= 0; i--) if (struggles[i].kind === "slow" && capped.has(struggles[i].steps[0])) struggles.splice(i, 1);
  const rank = { high: 0, medium: 1, low: 2 };
  struggles.sort((a, b) => rank[a.severity] - rank[b.severity] || b.costMs - a.costMs);

  const usage = trace.requests.reduce(
    (u, r) => {
      const x = r.usage ?? {};
      u.input += x.input_tokens ?? 0;
      u.cacheRead += x.cache_read_input_tokens ?? 0;
      u.cacheWrite += x.cache_creation_input_tokens ?? 0;
      u.output += x.output_tokens ?? 0;
      return u;
    },
    { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  );

  return {
    session: { ...s, firstAt: new Date(s.firstAt).toISOString(), lastAt: new Date(s.lastAt).toISOString() },
    prototypes: trace.meta.prototypes ?? [],
    wallMs: wall,
    activeMs: active,
    waitingOnPersonMs: idle,
    mainBuckets: buckets,
    workBuckets: allBuckets,
    groups: Object.values(groups).sort((a, b) => b.ms - a.ms),
    phases,
    agents,
    counts: { toolCalls: trace.tools.length, errors: trace.tools.filter((t) => t.error).length, modelRequests: trace.requests.length, personMessages: trace.prompts.filter((p) => p.from === "person").length, subagents: trace.agents.length - 1, compactions: trace.compactions.length },
    usage: { ...usage, peakContext: peak },
    noted,
    slowest: [...trace.tools].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 12).map((t) => ({ n: t.n, agent: t.agent, group: t.group, label: t.label, ms: t.ms, error: t.error })),
    struggles,
  };
}

/** A person's message on one line: a slash command by its name and
 *  arguments, pasted blocks folded. */
const promptLine = (text) => {
  const cmd = /<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/.exec(text);
  const s = cmd ? `${cmd[1]} ${cmd[2] ?? ""}` : text.replace(/<pasted_content[\s\S]*?<\/pasted_content>/g, "[pasted]").replace(/<[^>]+>/g, "");
  return s.replace(/\s+/g, " ").trim().slice(0, 70);
};
const lastLines = (s) => String(s ?? "").split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" ⏎ ").slice(0, 240);
/** The line of a failed step's output that says what went wrong: not
 *  the harness's "Exit code 1", not a lone brace; a JSON error's own
 *  message when there is one. */
const errorLine = (s) => {
  const text = String(s ?? "").replace(/<\/?[a-z_-]+>/g, "");
  const json = /"(?:error|message)"\s*:\s*"((?:[^"\\]|\\.){8,})"/.exec(text);
  if (json) return json[1].replace(/\\n/g, " ").slice(0, 200);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^(Exit code \d+|[{}\[\],]+)$/.test(l));
  return (lines.find((l) => /error|fail|refus|not allowed|denied|cannot|can't|missing|invalid|timed? ?out/i.test(l)) ?? lines[0] ?? "").slice(0, 200);
};
const firstLine = (s) => String(s ?? "").replace(/<\/?[a-z_-]+>/g, "").split("\n").map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 160) ?? "";
const clock = (t) => new Date(t).toISOString().slice(11, 19);
const pct = (v, total) => (total ? `${Math.round((100 * v) / total)}%` : "–");

// ---------------------------------------------------------------------
// Writing it up

function bucketTable(buckets, total) {
  const rows = Object.entries(buckets).sort((a, b) => b[1] - a[1]);
  return ["| Where | Time | Share |", "|---|---:|---:|", ...rows.filter(([, v]) => v >= 1000 || rows.length < 12).slice(0, 18).map(([k, v]) => `| ${k} | ${fmt(v)} | ${pct(v, total)} |`)].join("\n");
}

export function reportMarkdown(trace, a) {
  const s = a.session;
  const out = [];
  out.push(`# Trace ${s.id}`);
  out.push("");
  out.push(`- **Harness:** ${s.harness}${s.version ? ` ${s.version}` : ""}, model ${s.model ?? "?"}`);
  out.push(`- **Folder:** ${s.cwd ?? "?"}`);
  if (a.prototypes.length) out.push(`- **Prototypes:** ${a.prototypes.map((p) => `${p.codebase}/${p.slug ?? "?"}`).join(", ")}`);
  out.push(`- **Span:** ${s.firstAt.replace("T", " ").slice(0, 19)} → ${s.lastAt.slice(11, 19)} UTC, ${fmt(a.wallMs)} wall, **${fmt(a.activeMs)} working** (${fmt(a.waitingOnPersonMs)} waiting on the person${a.mainBuckets["Bash (sleep/poll)"] ? `; ${fmt(a.mainBuckets["Bash (sleep/poll)"])} of the working time is polling` : ""})`);
  out.push(`- **Work:** ${a.counts.toolCalls} tool calls (${a.counts.errors} failed), ${a.counts.modelRequests} model requests, ${a.counts.subagents} subagents, ${a.counts.personMessages} messages from the person, ${a.counts.compactions} compactions`);
  out.push(`- **Tokens:** ${Math.round(a.usage.output / 1000)}k out, ${Math.round(a.usage.input / 1000)}k fresh in, ${Math.round(a.usage.cacheRead / 1e6 * 10) / 10}M cache read, peak context ${Math.round(a.usage.peakContext / 1000)}k`);
  out.push("");
  out.push("## Struggles");
  out.push("");
  if (!a.struggles.length) out.push("Nothing flagged.");
  for (const x of a.struggles.slice(0, 30)) {
    out.push(`- **${x.severity}** ${x.title}${x.costMs ? ` — ${fmt(x.costMs)}` : ""}${x.steps.length ? ` (steps ${x.steps.slice(0, 8).join(", ")}${x.steps.length > 8 ? ", …" : ""})` : ""}`);
    if (x.detail) out.push(`  - ${x.detail.replace(/\s+/g, " ").slice(0, 300)}`);
  }
  out.push("");
  if (a.noted?.length) {
    out.push("## What the agents noticed");
    out.push("");
    out.push("Sentences where an agent said something went wrong. Kit bugs that exit cleanly but do the wrong thing often show only here.");
    out.push("");
    for (const x of a.noted.slice(0, 25)) out.push(`- ${clock(x.at)}${x.agent !== "main" ? ` (${x.agent.slice(0, 8)})` : ""}${x.step ? ` before step ${x.step}` : ""}: ${x.text.replace(/\s+/g, " ")}`);
    out.push("");
  }
  out.push("## Where the main session's time went");
  out.push("");
  out.push(bucketTable(a.mainBuckets, a.wallMs));
  out.push("");
  if (a.agents.length > 1) {
    out.push("## All work, main and subagents together");
    out.push("");
    out.push("Each agent's own time, added up, without waiting. Subagents run alongside the main session, so this can be more than the wall clock.");
    out.push("");
    const total = Object.values(a.workBuckets).reduce((n, v) => n + v, 0);
    out.push(bucketTable(a.workBuckets, total));
    out.push("");
    out.push("## Subagents");
    out.push("");
    out.push("| Agent | Task | Wall | Tool calls | Failed | Ended with |");
    out.push("|---|---|---:|---:|---:|---|");
    for (const g of a.agents.filter((x) => x.id !== "main")) out.push(`| ${g.type} \`${g.id.slice(0, 8)}\` | ${g.description.replace(/\|/g, "/").slice(0, 60)} | ${fmt(g.wallMs)} | ${g.toolCalls} | ${g.errors} | ${g.ended.replace(/\|/g, "/").slice(0, 160)} |`);
    out.push("");
  }
  out.push("## Phases");
  out.push("");
  out.push("Each starts at a message from the person or a skill starting, and runs to the next.");
  out.push("");
  out.push("| Start | Phase | Working | Wall | Tool calls | Failed |");
  out.push("|---|---|---:|---:|---:|---:|");
  for (const p of a.phases) out.push(`| ${clock(p.at)} | ${p.label.replace(/\|/g, "/")} | ${fmt(p.workingMs)} | ${fmt(p.ms)} | ${p.toolCalls} | ${p.errors} |`);
  out.push("");
  out.push("## Tools");
  out.push("");
  out.push("| Tool | Calls | Failed | Total | Longest |");
  out.push("|---|---:|---:|---:|---:|");
  for (const g of a.groups.filter((x) => !x.group.startsWith("waiting")).slice(0, 30)) out.push(`| ${g.group} | ${g.calls} | ${g.errors} | ${fmt(g.ms)} | ${fmt(g.maxMs)} |`);
  out.push("");
  out.push("## Slowest steps");
  out.push("");
  for (const t of a.slowest) out.push(`- step ${t.n} — ${fmt(t.ms)}${t.error ? " **failed**" : ""} — ${t.group}${t.agent !== "main" ? ` (${t.agent.slice(0, 8)})` : ""}: \`${t.label.slice(0, 120).replace(/`/g, "'")}\``);
  out.push("");
  out.push(`Open any step with \`node <kit>/tools/trace.mjs show ${s.id} <step>\`.`);
  return out.join("\n") + "\n";
}

/** The conversation as a person would read it: what was said, and each
 *  step on one line with how long it took and whether it failed. */
export function chatMarkdown(trace) {
  const items = [
    ...trace.prompts.filter((p) => p.agent === "main").map((p) => ({ at: p.at, kind: "prompt", p })),
    ...trace.requests.filter((r) => r.agent === "main" && r.text.trim()).map((r) => ({ at: r.end, kind: "text", r })),
    ...trace.tools.filter((t) => t.agent === "main").map((t) => ({ at: t.at, kind: "tool", t })),
  ].sort((a, b) => a.at - b.at);
  const out = [`# Conversation ${trace.session.id}`, "", trace.agents.length > 1 ? `Main session only. Subagents' steps (${trace.tools.filter((t) => t.agent !== "main").length} of them) are numbered in the same sequence, so numbers skip here; open them with \`trace.mjs show\` or in trace.html.\n` : ""];
  for (const it of items) {
    if (it.kind === "prompt") {
      const who = it.p.from === "person" ? "Person" : it.p.from === "background" ? "Background" : "Harness";
      const text = it.p.from === "person" ? it.p.text : it.p.text.replace(/\s+/g, " ").slice(0, 300) + (it.p.text.length > 300 ? " …" : "");
      out.push(`### ${who} · ${clock(it.at)}`, "", text.trim(), "");
    } else if (it.kind === "text") {
      out.push(`**Agent · ${clock(it.at)}**`, "", it.r.text.trim(), "");
    } else {
      const t = it.t;
      out.push(`- \`#${t.n}\` ${clock(t.at)} **${t.name}** ${fmt(t.ms)}${t.error ? " ❌" : ""}${t.unfinished ? " (never returned)" : ""} — \`${t.label.slice(0, 140).replace(/`/g, "'")}\``);
      if (t.error) out.push(`  - ${errorLine(t.output)}`);
      if (t.subagent) {
        const sub = trace.tools.filter((x) => x.agent === t.subagent);
        out.push(`  - subagent \`${t.subagent}\`: ${sub.length} steps, ${sub.filter((x) => x.error).length} failed`);
      }
      out.push("");
    }
  }
  return out.join("\n");
}
