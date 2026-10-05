/**
 * The whole transcript of a traced session, as a person reads it:
 * transcript.html and transcript.md in the trace folder. Nothing is
 * summarised or left out: every message from the person (typed between
 * turns or while the agent worked), the agent's text and thinking, each
 * tool call with its full input and output, background notifications
 * and subagents' hand-backs, what the harness injected, and each
 * subagent's own transcript nested under the call that started it.
 *
 * Read straight from the harness's files in the trace folder
 * (transcript.jsonl, subagents/), in the order they were written.
 * Claude Code in full; Codex rollouts and Cursor transcripts as far as
 * their formats carry it (Cursor keeps no times or tool output, so
 * those come from the trace hook's hooks.jsonl when it exists).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HTML_OUTPUT_CAP = 8_000;
const MD_OUTPUT_CAP = 50_000;
const MD_HARNESS_CAP = 2_000;

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
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content, null, 2);
  return content
    .map((b) => (typeof b === "string" ? b : b.type === "text" ? b.text : b.type === "image" ? "[image]" : b.type === "tool_reference" ? `[tool ${b.tool_name ?? ""}]` : JSON.stringify(b)))
    .join("\n");
}

/** Who a user-role message came from. */
function originOf(text, record) {
  if (record?.isCompactSummary) return "harness";
  if (record?.isMeta) return "harness";
  if (/^\s*<task-notification>|^\s*\[SYSTEM NOTIFICATION/.test(text)) return "background";
  if (/^\s*<agent-message\b/.test(text)) return "background";
  if (/^\s*<(local-command-stdout|local-command-stderr|system-reminder)>/.test(text) && !/<command-name>/.test(text)) return "harness";
  if (/^\s*Caveat: The messages below/.test(text)) return "harness";
  return "person";
}

/** One line naming a harness attachment, and its content when it has any. */
function attachmentItem(a) {
  const type = a.type ?? "attachment";
  const content = a.content ?? a.prompt ?? a.text ?? a.message ?? a.addedLines ?? a.entries ?? a.date ?? null;
  const body = content == null ? JSON.stringify(a, null, 2) : typeof content === "string" ? content : JSON.stringify(content, null, 2);
  const label = type === "edited_text_file" ? `edited file: ${a.filename ?? a.path ?? ""}` : type.replace(/_/g, " ");
  return { label, body };
}

// ---------------------------------------------------------------------
// Reading each harness into items

/** Claude Code: one file, in order. Tool results join their call. */
function claudeItems(path) {
  const items = [];
  const calls = new Map();
  for (const r of lines(path)) {
    const at = ms(r.timestamp);
    if (r.type === "assistant" && r.message) {
      for (const b of r.message.content ?? []) {
        if (b.type === "thinking" || b.type === "redacted_thinking") items.push({ kind: "thinking", at, text: b.thinking ?? "", hidden: !b.thinking });
        else if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", at, text: b.text, model: r.message.model });
        else if (b.type === "tool_use") {
          const call = { kind: "tool", at, id: b.id, name: b.name, input: b.input ?? {}, output: null, error: false, end: null };
          calls.set(b.id, call);
          items.push(call);
        }
      }
      if (r.message.stop_reason === "max_tokens") items.push({ kind: "event", at, label: "reply cut off (max tokens)" });
    } else if (r.type === "user" && r.message) {
      const content = r.message.content;
      const results = Array.isArray(content) ? content.filter((b) => b.type === "tool_result") : [];
      for (const b of results) {
        const call = calls.get(b.tool_use_id);
        if (!call) continue;
        call.output = textOf(b.content);
        call.error = Boolean(b.is_error);
        call.end = at;
        const res = r.toolUseResult;
        if (res && typeof res === "object") {
          if (res.agentId) call.subagent = res.agentId;
          if (res.interrupted) call.interrupted = true;
          if (typeof res.stderr === "string" && res.stderr.trim() && !call.output.includes(res.stderr.trim())) call.stderr = res.stderr;
        }
      }
      if (!results.length) {
        const text = textOf(content);
        if (text.trim()) items.push({ kind: originOf(text, r), at, text, images: Array.isArray(content) ? content.filter((b) => b.type === "image").length : 0 });
      }
    } else if (r.type === "attachment" && r.attachment) {
      const a = r.attachment;
      if (a.type === "queued_command") {
        const kind = a.origin?.kind === "human" || a.humanTurn ? "person" : "background";
        items.push({ kind, at, text: textOf(a.prompt), queued: true, from: a.origin?.name ?? a.origin?.from ?? a.commandMode });
      } else if (a.type !== "total_tokens_reminder") items.push({ kind: "harness", at, ...attachmentItem(a) });
    } else if (r.type === "system") {
      if (r.subtype === "api_error") items.push({ kind: "event", at, label: `API error (attempt ${r.retryAttempt ?? "?"}/${r.maxRetries ?? "?"})`, body: JSON.stringify(r.error ?? {}, null, 2), bad: true });
      else if (r.subtype === "compact_boundary") items.push({ kind: "event", at, label: `context compacted (${r.compactMetadata?.trigger ?? "?"}, ${r.compactMetadata?.preTokens ?? "?"} tokens before)`, bad: true });
      else if (r.subtype === "local_command") items.push({ kind: "harness", at, label: "local command", body: textOf(r.content) });
      else if (r.subtype === "stop_hook_summary" && (r.hookErrors?.length || r.preventedContinuation || r.hasOutput))
        items.push({ kind: "event", at, label: `stop hook${r.preventedContinuation ? " kept the agent going" : ""}${r.hookErrors?.length ? `, ${r.hookErrors.length} errors` : ""}`, body: JSON.stringify({ stopReason: r.stopReason, hookErrors: r.hookErrors, hookAdditionalContext: r.hookAdditionalContext }, null, 2), bad: Boolean(r.hookErrors?.length) });
      else if (r.subtype === "turn_duration") items.push({ kind: "event", at, label: `turn took ${Math.round((r.durationMs ?? 0) / 1000)}s`, quiet: true });
      else if (r.subtype && r.content) items.push({ kind: "harness", at, label: r.subtype.replace(/_/g, " "), body: textOf(r.content) });
    }
  }
  return items;
}

/** Codex: the Responses API items it rolls out, in order. */
function codexItems(path) {
  const items = [];
  const calls = new Map();
  for (const r of lines(path)) {
    const at = ms(r.timestamp);
    const p = r.payload ?? {};
    if (r.type === "response_item") {
      const text = textOf((p.content ?? []).map((c) => ({ type: "text", text: c.text ?? "" })));
      if (p.type === "message" && p.role === "user") items.push({ kind: /^<(environment_context|user_instructions|permissions)/.test(text.trim()) ? "harness" : originOf(text), at, text, label: "context" });
      else if (p.type === "message" && p.role === "developer") items.push({ kind: "harness", at, label: "developer message", body: text });
      else if (p.type === "message") items.push({ kind: "text", at, text });
      else if (p.type === "reasoning") {
        const summary = (p.summary ?? []).map((s) => s.text ?? "").join("\n");
        items.push({ kind: "thinking", at, text: summary, hidden: !summary });
      } else if (["function_call", "custom_tool_call", "local_shell_call"].includes(p.type)) {
        let input = p.arguments ?? p.input ?? p.action ?? {};
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            input = { input };
          }
        }
        const call = { kind: "tool", at, id: p.call_id ?? p.id, name: p.name ?? p.type, input, output: null, error: false, end: null };
        calls.set(call.id, call);
        items.push(call);
      } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
        const call = calls.get(p.call_id);
        if (call) {
          call.output = typeof p.output === "string" ? p.output : JSON.stringify(p.output, null, 2);
          call.end = at;
          call.error = /"exit_code":\s*[1-9]|Process exited with code [1-9]/.test(call.output);
        }
      }
    } else if (r.type === "event_msg") {
      if (p.type === "error" || p.type === "stream_error") items.push({ kind: "event", at, label: "error", body: String(p.message ?? ""), bad: true });
      if (p.type === "turn_aborted") items.push({ kind: "event", at, label: "turn aborted", bad: true });
      if (p.type === "context_compacted") items.push({ kind: "event", at, label: "context compacted", bad: true });
    } else if (r.type === "compacted") items.push({ kind: "event", at, label: "context compacted", bad: true });
  }
  return items;
}

/** Cursor: messages in order; outputs and times from hooks.jsonl, matched to calls in order. */
function cursorItems(path, dir) {
  const events = lines(join(dir, "hooks.jsonl"));
  const items = [];
  let e = 0;
  for (const r of lines(path)) {
    const role = r.role ?? r.message?.role;
    const content = r.message?.content ?? r.content;
    const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content ?? "") }];
    for (const b of blocks) {
      if (b.type === "text" && b.text?.trim()) {
        const text = b.text.replace(/^<user_query>\s*|\s*<\/user_query>$/g, "");
        items.push(role === "user" ? { kind: originOf(text), at: NaN, text } : { kind: "text", at: NaN, text });
      } else if (b.type === "tool_use") {
        const ev = events[e++];
        items.push({ kind: "tool", at: ev ? ms(ev.at) - (ev.ms ?? 0) : NaN, end: ev ? ms(ev.at) : null, name: b.name, input: b.input ?? {}, output: ev?.output ?? null, error: Boolean(ev?.error) });
      } else if (b.type === "thinking" || b.type === "reasoning") items.push({ kind: "thinking", at: NaN, text: b.thinking ?? b.text ?? "", hidden: !(b.thinking ?? b.text) });
    }
  }
  return items;
}

/** Every agent's items, and which tool call started which subagent. */
export function readTranscript(dir) {
  let meta = {};
  try {
    meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  } catch {}
  const harness = meta.harness ?? "claude-code";
  const read = harness === "codex" ? codexItems : harness === "cursor" ? (p) => cursorItems(p, dir) : claudeItems;
  const agents = new Map([["main", { id: "main", type: "main", description: meta.sessionId ?? "", items: read(join(dir, "transcript.jsonl")) }]]);
  const byToolUse = new Map();
  const subDir = join(dir, "subagents");
  if (existsSync(subDir)) {
    for (const name of readdirSync(subDir).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const id = harness === "codex" ? (/-([0-9a-f-]{36})\.jsonl$/.exec(name)?.[1] ?? name) : name.replace(/^agent-/, "").replace(/\.jsonl$/, "");
      let m = {};
      try {
        m = JSON.parse(readFileSync(join(subDir, name.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      } catch {}
      agents.set(id, { id, type: m.agentType ?? "subagent", description: m.description ?? "", items: read(join(subDir, name)) });
      if (m.toolUseId) byToolUse.set(m.toolUseId, id);
    }
  }
  for (const a of agents.values()) for (const it of a.items) if (it.kind === "tool" && !it.subagent && byToolUse.has(it.id)) it.subagent = byToolUse.get(it.id);
  // A subagent's messages come from the agent that started it, not a person.
  for (const a of agents.values()) if (a.id !== "main") for (const it of a.items) if (it.kind === "person") it.kind = "task";
  return { meta, harness, agents };
}

// ---------------------------------------------------------------------
// Writing it out

const clock = (t) => (Number.isNaN(t) || t == null ? "" : new Date(t).toISOString().slice(11, 19));
const took = (a, b) => {
  if (a == null || b == null || Number.isNaN(a) || Number.isNaN(b)) return "";
  const s = (b - a) / 1000;
  return s >= 60 ? `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s` : `${s.toFixed(1)}s`;
};
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cap = (s, n) => (s && s.length > n ? `${s.slice(0, n)}\n… [${s.length - n} more characters in transcript.jsonl]` : s ?? "");

/** A tool call's input on one line, for its summary row. */
function inputLine(it) {
  const i = it.input ?? {};
  const s = i.command ?? i.cmd ?? (i.file_path ? `${i.file_path}` : null) ?? i.pattern ?? i.url ?? i.description ?? i.skill ?? i.prompt ?? JSON.stringify(i);
  return String(Array.isArray(s) ? s.join(" ") : s).replace(/\s+/g, " ").slice(0, 220);
}

/** The input in full: a command as a command, an edit as its two sides, anything else as JSON. */
function inputBody(it) {
  const i = it.input ?? {};
  const cmd = i.command ?? i.cmd;
  if (typeof cmd === "string" && Object.keys(i).every((k) => ["command", "cmd", "description", "timeout", "run_in_background", "workdir"].includes(k))) return cmd;
  return JSON.stringify(i, null, 2);
}

/** Runs of harness items (context the harness injects each turn) as one
 *  folded row, so the conversation stays readable. */
function grouped(items) {
  const out = [];
  for (const it of items) {
    const last = out.at(-1);
    if (it.kind === "harness" && last?.kind === "harness-run") last.items.push(it);
    else if (it.kind === "harness") out.push({ kind: "harness-run", at: it.at, items: [it] });
    else out.push(it);
  }
  return out;
}

function htmlItems(t, agentId, seen) {
  const agent = t.agents.get(agentId);
  const out = [];
  for (const it of grouped(agent.items)) {
    const time = clock(it.at);
    if (it.kind === "person") out.push(`<h3>Person${it.queued ? " (while the agent worked)" : ""} <small>${time}</small></h3>\n<div class="say">${esc(it.text.trim())}</div>`);
    else if (it.kind === "task") out.push(`<h3>Task <small>${time}</small></h3>\n<div class="say">${esc(it.text.trim())}</div>`);
    else if (it.kind === "text") out.push(`<h3>Agent <small>${time}</small></h3>\n<div class="say">${esc(it.text.trim())}</div>`);
    else if (it.kind === "background") out.push(`<details><summary><small>${time}</small> background: ${esc(it.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120))}</summary><pre>${esc(cap(it.text, HTML_OUTPUT_CAP))}</pre></details>`);
    else if (it.kind === "harness-run") out.push(`<p class="m"><small>${time}</small> harness: ${esc([...new Set(it.items.map((x) => x.label ?? "message"))].join(", ").slice(0, 200))}</p>`);
    else if (it.kind === "thinking") {
      if (!it.hidden) out.push(`<details><summary><small>${time}</small> thinking</summary><pre>${esc(it.text)}</pre></details>`);
    } else if (it.kind === "event") out.push(`<p class="m"><small>${time}</small> ${esc(it.label)}</p>`);
    else if (it.kind === "tool") {
      const status = it.output == null ? " (no result)" : it.error ? " <b>failed</b>" : "";
      out.push(`<details><summary><small>${time}</small> <b>${esc(it.name)}</b> ${esc(took(it.at, it.end))}${status} <code>${esc(inputLine(it).slice(0, 140))}</code></summary><pre>${esc(cap(inputBody(it), HTML_OUTPUT_CAP))}</pre><pre>${esc(cap(it.output ?? "(no result recorded)", HTML_OUTPUT_CAP))}</pre></details>`);
      if (it.subagent && t.agents.has(it.subagent) && !seen.has(it.subagent)) {
        const a = t.agents.get(it.subagent);
        seen.add(it.subagent);
        out.push(`<details class="sub"><summary>subagent ${esc(a.type)}: ${esc(a.description)}</summary>\n${htmlItems(t, it.subagent, seen)}\n</details>`);
      }
    }
  }
  return out.join("\n");
}

export function transcriptHtml(dir) {
  const t = readTranscript(dir);
  const seen = new Set(["main"]);
  const main = htmlItems(t, "main", seen);
  const rest = [...t.agents.keys()].filter((id) => !seen.has(id)).map((id) => {
    const a = t.agents.get(id);
    seen.add(id);
    return `<details class="sub"><summary>subagent ${esc(a.type)}: ${esc(a.description)}</summary>\n${htmlItems(t, id, seen)}\n</details>`;
  }).join("\n");
  const id = t.meta.sessionId ?? "";
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript ${esc(id.slice(0, 8))}</title>
<style>
body{max-width:900px;margin:2em auto;padding:0 1em;font:15px/1.5 system-ui,sans-serif}
h3{margin:1.5em 0 .3em;font-size:1em}small,.m{color:#777}.m{margin:.3em 0;font-size:.85em}
.say{white-space:pre-wrap}pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f6f6f6;padding:.5em;max-height:30em;overflow:auto}
code{font-size:12px}details{margin:.2em 0}summary{cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.sub{margin-left:1.5em;border-left:2px solid #ddd;padding-left:.8em}
@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}pre{background:#1c1c1c}.sub{border-color:#333}}
</style>
<h1>Transcript</h1>
<p class="m">${esc(id)} · ${esc(t.harness)} · times UTC · <a href="trace.html">analysis</a> · full text in transcript.md</p>
${main}
${rest}
`;
}

function mdItems(t, agentId, depth, seen) {
  const agent = t.agents.get(agentId);
  const h = "#".repeat(Math.min(6, depth + 2));
  const fence = (s) => {
    const body = String(s ?? "");
    const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${ticks}\n${body}\n${ticks}`;
  };
  const out = [];
  for (const it of agent.items) {
    const time = clock(it.at);
    if (it.kind === "task") out.push(`**Task from the agent that started it · ${time}**\n\n${it.text.trim()}\n`);
    else if (it.kind === "person") out.push(`${h} Person${it.queued ? " (sent while the agent worked)" : ""} · ${time}\n\n${it.text.trim()}\n`);
    else if (it.kind === "background") out.push(`**Background · ${time}**${it.from ? ` (${it.from})` : ""}\n\n${fence(it.text.trim())}\n`);
    else if (it.kind === "harness") out.push(`*Harness · ${time} · ${it.label ?? ""}*\n\n${fence(cap(it.body ?? it.text, MD_HARNESS_CAP))}\n`);
    else if (it.kind === "text") out.push(`${h} Agent · ${time}\n\n${it.text.trim()}\n`);
    else if (it.kind === "thinking") out.push(it.hidden ? `*thinking · ${time} (text not kept)*\n` : `*thinking · ${time}*\n\n> ${it.text.trim().replace(/\n/g, "\n> ")}\n`);
    else if (it.kind === "event") out.push(`*${time} · ${it.label}*${it.body ? `\n\n${fence(it.body)}` : ""}\n`);
    else if (it.kind === "tool") {
      out.push(`**Tool · ${time} · ${it.name}** ${took(it.at, it.end)}${it.error ? " · FAILED" : ""}${it.output == null ? " · no result" : ""}\n\n${fence(inputBody(it))}\n\nOutput:\n\n${fence(cap(it.output ?? "(no result recorded)", MD_OUTPUT_CAP))}\n${it.stderr ? `\nStderr:\n\n${fence(cap(it.stderr, MD_OUTPUT_CAP))}\n` : ""}`);
      if (it.subagent && t.agents.has(it.subagent) && !seen.has(it.subagent)) {
        const a = t.agents.get(it.subagent);
        seen.add(it.subagent);
        out.push(`${h}# Subagent ${a.type}: ${a.description}\n\n${mdItems(t, it.subagent, depth + 1, seen)}\n${h}# End of subagent ${a.type}\n`);
      }
    }
  }
  return out.join("\n");
}

export function transcriptMarkdown(dir) {
  const t = readTranscript(dir);
  const seen = new Set(["main"]);
  const main = mdItems(t, "main", 0, seen);
  const rest = [...t.agents.keys()].filter((id) => !seen.has(id)).map((id) => {
    const a = t.agents.get(id);
    seen.add(id);
    return `## Subagent ${a.type}: ${a.description} (not matched to a call)\n\n${mdItems(t, id, 1, seen)}`;
  });
  return `# Transcript ${t.meta.sessionId ?? ""}\n\nEverything the session recorded, in order (times UTC). Outputs over ${MD_OUTPUT_CAP / 1000}k characters are cut; transcript.jsonl has them whole.\n\n${main}\n${rest.join("\n")}`;
}
