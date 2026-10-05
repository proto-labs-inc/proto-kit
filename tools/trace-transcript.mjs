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

const HTML_OUTPUT_CAP = 100_000;
const MD_OUTPUT_CAP = 50_000;

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
  let prev = null;
  const out = [];
  for (const it of grouped(agent.items)) {
    const gap = prev != null && it.at - prev >= 30_000 ? `<div class="gap">${esc(took(prev, it.at))} later</div>` : "";
    if (!Number.isNaN(it.at)) prev = it.end ?? it.at;
    const time = `<span class="time">${clock(it.at)}</span>`;
    if (it.kind === "person") out.push(`${gap}<div class="msg person" data-kind="person">${time}<h4>${it.queued ? "Person (sent while the agent worked)" : "Person"}${it.images ? ` · ${it.images} image${it.images > 1 ? "s" : ""}` : ""}</h4><pre>${esc(it.text)}</pre></div>`);
    else if (it.kind === "background") out.push(`${gap}<details class="msg background" data-kind="background"><summary>${time}<b>Background</b> ${esc(it.from ? `${it.from}: ` : "")}${esc(it.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160))}</summary><pre>${esc(it.text)}</pre></details>`);
    else if (it.kind === "harness-run") {
      const names = [...new Set(it.items.map((x) => x.label ?? (x.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 60)))];
      const inner = it.items.map((x) => `<details class="harness-item"><summary>${esc(x.label ?? (x.text ?? "").replace(/\s+/g, " ").slice(0, 120))}</summary><pre>${esc(cap(x.body ?? x.text, HTML_OUTPUT_CAP))}</pre></details>`).join("");
      out.push(`${gap}<details class="harness" data-kind="harness"><summary>${time}harness: ${esc(names.join(" · ").slice(0, 200))}</summary>${inner}</details>`);
    } else if (it.kind === "task") out.push(`${gap}<details class="msg task" data-kind="task"><summary>${time}<b>Task from the agent that started it</b> ${esc(it.text.replace(/\s+/g, " ").slice(0, 140))}</summary><pre>${esc(it.text)}</pre></details>`);
    else if (it.kind === "text") out.push(`${gap}<div class="msg agent" data-kind="text">${time}<h4>Agent</h4><pre>${esc(it.text)}</pre></div>`);
    else if (it.kind === "thinking") out.push(it.hidden ? `<div class="thinking hidden" data-kind="thinking">${time}thinking (its text is not kept in the transcript)</div>` : `${gap}<details class="thinking" data-kind="thinking" open><summary>${time}thinking</summary><pre>${esc(it.text)}</pre></details>`);
    else if (it.kind === "event") out.push(`${gap}${it.body ? `<details class="event${it.bad ? " bad" : ""}${it.quiet ? " quiet" : ""}" data-kind="event"><summary>${time}${esc(it.label)}</summary><pre>${esc(it.body)}</pre></details>` : `<div class="event${it.bad ? " bad" : ""}${it.quiet ? " quiet" : ""}" data-kind="event">${time}${esc(it.label)}</div>`}`);
    else if (it.kind === "tool") {
      const status = it.output == null ? `<span class="badge open">no result</span>` : it.error ? `<span class="badge bad">failed</span>` : "";
      const sub = it.subagent && t.agents.has(it.subagent) && !seen.has(it.subagent)
        ? (() => {
            const a = t.agents.get(it.subagent);
            seen.add(it.subagent);
            return `<details class="subagent"><summary>Subagent <b>${esc(a.type)}</b> ${esc(a.description)} · ${a.items.filter((x) => x.kind === "tool").length} tool calls</summary>${htmlItems(t, it.subagent, seen)}</details>`;
          })()
        : "";
      out.push(`${gap}<details class="tool${it.error ? " failed" : ""}" data-kind="tool"><summary>${time}<b>${esc(it.name)}</b> <span class="took">${esc(took(it.at, it.end))}</span> ${status}<code>${esc(inputLine(it))}</code></summary><div class="io"><div class="label">input</div><pre>${esc(inputBody(it))}</pre><div class="label">output${it.output ? ` · ${it.output.length} chars` : ""}</div><pre>${esc(cap(it.output ?? "(no result recorded)", HTML_OUTPUT_CAP))}</pre>${it.stderr ? `<div class="label">stderr</div><pre>${esc(cap(it.stderr, HTML_OUTPUT_CAP))}</pre>` : ""}</div></details>${sub}`);
    }
  }
  return out.join("\n");
}

export function transcriptHtml(dir) {
  const t = readTranscript(dir);
  const seen = new Set(["main"]);
  const main = htmlItems(t, "main", seen);
  const orphans = [...t.agents.keys()].filter((id) => !seen.has(id));
  const rest = orphans.map((id) => {
    const a = t.agents.get(id);
    seen.add(id);
    return `<details class="subagent"><summary>Subagent <b>${esc(a.type)}</b> ${esc(a.description)} (not matched to a call)</summary>${htmlItems(t, id, seen)}</details>`;
  }).join("\n");
  const id = t.meta.sessionId ?? "";
  const counts = [...t.agents.values()].reduce((c, a) => {
    for (const it of a.items) c[it.kind] = (c[it.kind] ?? 0) + 1;
    return c;
  }, {});
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript ${esc(id.slice(0, 8))}</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1c1a;--muted:#6f6b64;--line:#e7e3dc;--accent:#2f5fd0;--bad:#c4372b;--soft:#f3f1ec;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--panel:#1f1e1c;--ink:#ecebe8;--muted:#9c978f;--line:#33312d;--accent:#7aa2ff;--bad:#ff6b5e;--soft:#262522}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.45}
main{max-width:1100px;margin:0 auto;padding:16px 16px 80px}
header{position:sticky;top:0;background:var(--bg);padding:10px 0;border-bottom:1px solid var(--line);z-index:2}
h1{font-size:18px;margin:0 0 4px}.muted{color:var(--muted)}
.bar{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;font-size:13px;margin-top:6px}
.bar button{font:inherit;padding:3px 9px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;margin:4px 0 0;font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.time{color:var(--muted);font:11px ui-monospace,Menlo,monospace;margin-right:8px}
.msg{margin:10px 0;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel)}
.msg h4{display:inline;margin:0;font-size:12px;color:var(--muted)}
.msg.person{border-left:3px solid var(--accent)}.msg.person pre{font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.msg.agent pre{font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.msg.background,.msg.task{background:var(--soft);font-size:12px}
.harness{margin:2px 0;font-size:11.5px;color:var(--muted)}.harness>summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.harness-item{margin:2px 0 2px 16px}.harness-item pre{background:var(--soft);border-radius:6px;padding:6px 8px;max-height:400px;overflow:auto}
a{color:var(--accent)}
details>summary{cursor:pointer;list-style:none}details>summary::-webkit-details-marker{display:none}
details>summary::before{content:"▸";display:inline-block;width:12px;color:var(--muted)}details[open]>summary::before{content:"▾"}
.tool{margin:3px 0;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--panel)}
.tool summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tool code{color:var(--muted);font:12px ui-monospace,Menlo,monospace;margin-left:6px}
.tool.failed{border-color:color-mix(in srgb,var(--bad) 50%,var(--line))}
.io{padding:4px 0 4px 12px}.io pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;max-height:520px;overflow:auto}
.label{font-size:11px;color:var(--muted);margin-top:6px;text-transform:uppercase;letter-spacing:.04em}
.took{color:var(--muted);font-size:12px}
.badge{font-size:11px;padding:0 6px;border-radius:4px;margin-left:4px}.badge.bad{background:var(--bad);color:#fff}.badge.open{border:1px solid var(--muted);color:var(--muted)}
.thinking{margin:4px 0;padding:4px 10px;color:var(--muted);font-style:italic;font-size:13px;border-left:2px dashed var(--line)}.thinking.hidden{font-size:12px}
.event{margin:4px 0;font-size:12px;color:var(--muted)}.event.bad{color:var(--bad)}
.gap{text-align:center;color:var(--muted);font-size:11px;margin:12px 0;border-top:1px dashed var(--line);line-height:0}.gap{padding-top:2px}
.subagent{margin:6px 0 10px 18px;padding:6px 10px;border-left:3px solid var(--line);background:color-mix(in srgb,var(--soft) 60%,transparent);border-radius:0 8px 8px 0}
.subagent>summary{font-size:13px;color:var(--muted)}
body.no-harness [data-kind=harness],body.no-harness [data-kind=background]{display:none}
body.no-thinking [data-kind=thinking]{display:none}
body.no-quiet .quiet{display:none}
body.only-talk [data-kind=tool],body.only-talk [data-kind=event],body.only-talk [data-kind=thinking],body.only-talk [data-kind=harness]{display:none}
</style>
</head>
<body class="no-quiet">
<main>
<header>
<h1>Transcript <span class="muted" style="font:13px ui-monospace,Menlo,monospace">${esc(id)}</span></h1>
<div class="muted" style="font-size:12px">${esc(t.harness)} · ${t.agents.get("main").items.filter((x) => x.kind === "person").length} from the person · ${counts.text ?? 0} agent messages · ${counts.tool ?? 0} tool calls · ${counts.background ?? 0} background · ${t.agents.size - 1} subagents · times are UTC · <a href="trace.html">analysis</a></div>
<div class="bar">
<label><input type="checkbox" data-hide="no-harness"> hide harness and background</label>
<label><input type="checkbox" data-hide="no-thinking"> hide thinking</label>
<label><input type="checkbox" data-hide="only-talk"> conversation only</label>
<button id="open">open all</button><button id="close">close all</button>
</div>
</header>
${main}
${rest}
</main>
<script>
document.querySelectorAll("[data-hide]").forEach(c=>c.addEventListener("change",()=>document.body.classList.toggle(c.dataset.hide,c.checked)));
document.getElementById("open").onclick=()=>document.querySelectorAll("details").forEach(d=>d.open=true);
document.getElementById("close").onclick=()=>document.querySelectorAll("details").forEach(d=>d.open=false);
</script>
</body>
</html>
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
    else if (it.kind === "harness") out.push(`*Harness · ${time} · ${it.label ?? ""}*\n\n${fence(cap(it.body ?? it.text, MD_OUTPUT_CAP))}\n`);
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
