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
// Ids and flags

/**
 * Every step and message gets a short id a person and an agent can both
 * say: s12 is the twelfth tool call of the session (the analysis counts
 * the same way, across subagents, by time), m3 the third message. Both
 * count in time order, so a session that grows keeps its earlier ids,
 * and flags written against them stay put.
 */
export function numberTranscript(t, trace) {
  const stepOf = new Map((trace?.tools ?? []).map((x) => [x.id, x.n]));
  let fallback = stepOf.size;
  const all = [...t.agents.values()].flatMap((a) => a.items.map((it) => ({ it, a })));
  for (const { it } of all) if (it.kind === "tool") it.sid = `s${stepOf.get(it.id) ?? ++fallback}`;
  const said = all.filter(({ it }) => ["person", "task", "text", "background"].includes(it.kind)).sort((x, y) => (x.it.at || 0) - (y.it.at || 0));
  said.forEach(({ it }, i) => (it.mid = `m${i + 1}`));
  return t;
}

const FLAG_KINDS = ["error", "slow", "improve", "note", "good", "phase"];
export { FLAG_KINDS };

function flagsByTarget(flags) {
  const by = new Map();
  for (const f of (flags ?? []).filter((x) => x.kind !== "phase")) (by.get(f.target) ?? by.set(f.target, []).get(f.target)).push(f);
  return by;
}

// ---------------------------------------------------------------------
// Writing it out

const clock = (t) => (Number.isNaN(t) || t == null ? "" : new Date(t).toISOString().slice(11, 19));
const span = (a, b) => (a == null || b == null || Number.isNaN(a) || Number.isNaN(b) ? null : b - a);
const fmt = (ms) => (ms == null ? "" : ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)}h` : ms >= 60e3 ? `${Math.floor(ms / 60e3)}m${String(Math.round((ms % 60e3) / 1e3)).padStart(2, "0")}s` : `${(ms / 1e3).toFixed(1)}s`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const oneLine = (s, n) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const SLOW_MS = 30_000;
/** How much of a step's command, and of a failed step's output, its row shows when opened. */
const INLINE = 3_000;

/** A tool call's input on one line, for its row. */
function inputLine(it) {
  const i = it.input ?? {};
  const s = i.command ?? i.cmd ?? (i.file_path ? `${i.file_path}` : null) ?? i.pattern ?? i.url ?? i.description ?? i.skill ?? i.prompt ?? JSON.stringify(i);
  return String(Array.isArray(s) ? s.join(" ") : s).replace(/\s+/g, " ").slice(0, 220);
}

/** The input in full: a command as a command, anything else as JSON. */
function inputBody(it) {
  const i = it.input ?? {};
  const cmd = i.command ?? i.cmd;
  if (typeof cmd === "string" && Object.keys(i).every((k) => ["command", "cmd", "description", "timeout", "run_in_background", "workdir"].includes(k))) return cmd;
  return JSON.stringify(i, null, 2);
}

const errorLine = (out) => (out ?? "").replace(/<\/?[a-z_-]+>/g, "").split("\n").map((l) => l.trim()).find((l) => l && !/^Exit code \d+$/.test(l))?.slice(0, 200) ?? "";

/** Runs of harness items (context the harness injects each turn) as one. */
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

/** The main session in turns: each starts at a message the person typed
 *  between turns, and holds everything until the next. */
function turnsOf(items) {
  const turns = [];
  for (const it of grouped(items)) {
    if ((it.kind === "person" && !it.queued) || !turns.length) turns.push({ items: [] });
    turns.at(-1).items.push(it);
  }
  return turns;
}

/** Tool calls of an agent and of every subagent it started. */
function stepsUnder(t, items, seen = new Set()) {
  const out = [];
  for (const it of items) {
    if (it.kind !== "tool") continue;
    out.push(it);
    if (it.subagent && t.agents.has(it.subagent) && !seen.has(it.subagent)) {
      seen.add(it.subagent);
      out.push(...stepsUnder(t, t.agents.get(it.subagent).items, seen));
    }
  }
  return out;
}

export const PAGE_STYLE = `<style>
body{max-width:960px;margin:2em auto;padding:0 1em;font:15px/1.5 system-ui,sans-serif}
h1{font-size:1.4em;margin:0}h2{font-size:1.1em;margin:1.6em 0 .4em}small,.m{color:#777}.m{font-size:.85em}
.say{white-space:pre-wrap;margin:.2em 0 .8em}.who{font-weight:600;margin-top:1em}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;background:#f6f6f6;padding:.5em;max-height:30em;overflow:auto}
code{font-size:12px}details.step{margin:.1em 0}details.step>summary{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}details.step[open]>summary{white-space:normal}details.step>pre,details.step>p{margin-left:3.4em}.line{margin:.1em 0 .1em 1em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.err{color:#b42318;font-size:.85em;margin:0 0 .2em 4.6em}pre.err{margin-left:3.4em;font-size:12px}
.id{display:inline-block;min-width:3.2em;color:#777;font:12px ui-monospace,monospace;text-decoration:none}
details{margin:.3em 0}summary{cursor:pointer}details.turn{border-top:1px solid #ddd;padding-top:.4em;margin-top:.8em}details.turn>summary{font-weight:600}details.phase{margin:.6em 0 .6em .4em}details.phase>summary{font-weight:600;font-size:.95em}
.sub{margin:.3em 0 .3em 2em;border-left:2px solid #ddd;padding-left:.8em}
.flag{background:#fff6d6}.flag.error{background:#fde7e7}.flag.good{background:#e6f6ea}
.note{margin:.1em 0 .4em 3.4em;font-size:.88em}.note b{text-transform:uppercase;font-size:.8em;letter-spacing:.04em}
table{border-collapse:collapse;margin:.3em 0}td,th{text-align:left;padding:2px 14px 2px 0;vertical-align:top;font-size:.9em}td.r,th.r{text-align:right}
@media (prefers-color-scheme:dark){body{background:#111;color:#ddd}pre{background:#1c1c1c}.sub,details.turn{border-color:#333}a{color:#8ab4f8}.flag{background:#3a3214}.flag.error{background:#3d1d1d}.flag.good{background:#173322}.err{color:#ff8a80}}
</style>`;

/** A page under transcript/ holding texts in full, so the main page
 *  carries one line per step and stays light. */
function subpage(pages, name, title, sections) {
  pages.set(name, `<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n${PAGE_STYLE}\n<p class="m"><a href="../transcript.html">← transcript</a></p>\n<h1>${esc(title)}</h1>\n${sections.map(([heading, body]) => `<h2>${esc(heading)} <small>${String(body ?? "").length} characters</small></h2>\n<pre style="max-height:none">${esc(body ?? "")}</pre>`).join("\n")}\n`);
  return `transcript/${name}`;
}

function notes(list) {
  return (list ?? []).map((f) => `<div class="note"><b>${esc(f.kind)}</b> ${esc(f.note)} <small>${esc(f.by ?? "")} · ${esc(f.id)}</small></div>`).join("");
}

function htmlItems(t, items, seen, pages, flags) {
  const out = [];
  for (const it of items) {
    const time = clock(it.at);
    const mine = flags.get(it.sid ?? it.mid);
    const cls = mine ? ` flag ${mine.map((f) => f.kind).join(" ")}` : "";
    const who = { person: it.queued ? "Person, while the agent worked" : "Person", task: "Task from the agent that started it", text: "Agent" }[it.kind];
    if (who) out.push(`<div id="${it.mid}" class="msg${cls}"><div class="who"><a class="id" href="#${it.mid}">${it.mid}</a>${esc(who)} <small>${time}</small></div><div class="say">${esc(it.text.trim())}</div>${notes(mine)}</div>`);
    else if (it.kind === "background") out.push(`<details id="${it.mid}" class="m${cls}"><summary><a class="id" href="#${it.mid}">${it.mid}</a>${time} background: ${esc(oneLine(it.text, 140))}</summary><pre>${esc(it.text)}</pre></details>${notes(mine)}`);
    else if (it.kind === "harness-run") {
      const href = subpage(pages, `h${pages.size + 1}.html`, `harness · ${time}`, it.items.map((x) => [x.label ?? "message", x.body ?? x.text ?? ""]));
      out.push(`<p class="line m"><span class="id"></span>${time} <a href="${href}">harness</a>: ${esc(oneLine([...new Set(it.items.map((x) => x.label ?? "message"))].join(", "), 180))}</p>`);
    } else if (it.kind === "thinking") {
      if (!it.hidden) out.push(`<details class="m"><summary><span class="id"></span>${time} thinking</summary><pre>${esc(it.text)}</pre></details>`);
    } else if (it.kind === "event") out.push(`<p class="line m"><span class="id"></span>${time} ${esc(it.label)}</p>`);
    else if (it.kind === "tool") {
      const ms = span(it.at, it.end);
      const href = subpage(pages, `${it.sid}.html`, `${it.sid} · ${it.name} · ${time} · ${fmt(ms)}${it.error ? " · failed" : ""}`, [["input", inputBody(it)], ["output", it.output ?? "(no result recorded)"], ...(it.stderr ? [["stderr", it.stderr]] : [])]);
      const took = ms == null ? "" : ms >= SLOW_MS ? `<b>${fmt(ms)}</b>` : fmt(ms);
      const status = it.output == null ? " <small>(no result)</small>" : it.error ? " <b>failed</b>" : "";
      // One line, and on a click the command in full (and, for a failed
      // step, what it said); the step's own page has every character.
      const input = inputBody(it);
      const output = it.output ?? "";
      const more = `<pre>${esc(input.length > INLINE ? `${input.slice(0, INLINE)}…` : input)}</pre>${it.error && output ? `<pre class="err">${esc(output.length > INLINE ? `${output.slice(0, INLINE)}…` : output)}</pre>` : ""}<p class="m"><a href="${href}">full input and output</a> <small>(${input.length + output.length} characters)</small></p>`;
      out.push(`<details class="step${cls}" id="${it.sid}"><summary><a class="id" href="#${it.sid}">${it.sid}</a>${time} <b>${esc(it.name)}</b> <small>${took}</small>${status} <code>${esc(inputLine(it).slice(0, 150))}</code></summary>${more}</details>${it.error && output ? `<div class="err">${esc(errorLine(output))}</div>` : ""}${notes(mine)}`);
      if (it.subagent && t.agents.has(it.subagent) && !seen.has(it.subagent)) {
        const a = t.agents.get(it.subagent);
        seen.add(it.subagent);
        const steps = stepsUnder(t, a.items, new Set(seen));
        const first = a.items.find((x) => !Number.isNaN(x.at))?.at;
        const last = a.items.findLast((x) => !Number.isNaN(x.at));
        out.push(`<details class="sub"><summary>subagent <b>${esc(a.type)}</b>: ${esc(a.description)} <small>· ${fmt(span(first, last?.end ?? last?.at))} · ${steps.length} steps${steps.some((x) => x.error) ? ` · ${steps.filter((x) => x.error).length} failed` : ""}</small></summary>\n${htmlItems(t, grouped(a.items), seen, pages, flags)}\n</details>`);
      }
    }
  }
  return out.join("\n");
}

function table(head, rows, right = []) {
  return `<table>\n<tr>${head.map((h, i) => `<th${right.includes(i) ? ' class="r"' : ""}>${esc(h)}</th>`).join("")}</tr>\n${rows.map((r) => `<tr>${r.map((c, i) => `<td${right.includes(i) ? ' class="r"' : ""}>${c}</td>`).join("")}</tr>`).join("\n")}\n</table>`;
}

/** transcript.html, and the pages its long texts live on (name → html). */
export function transcriptHtml(dir, { trace, summary, flags = [] } = {}) {
  const t = numberTranscript(readTranscript(dir), trace);
  const byTarget = flagsByTarget(flags);
  const pages = new Map();
  const seen = new Set(["main"]);
  const main = t.agents.get("main");
  const sid = (n) => `<a href="#s${n}">s${n}</a>`;

  const turns = turnsOf(main.items).map((turn, i) => {
    const steps = stepsUnder(t, turn.items, new Set(seen));
    const timed = turn.items.filter((x) => !Number.isNaN(x.at));
    const working = span(timed[0]?.at, Math.max(...timed.map((x) => x.end ?? x.at)));
    const opener = turn.items.find((x) => x.kind === "person");
    const flagged = [...turn.items, ...steps].filter((x) => byTarget.has(x.sid ?? x.mid)).length;
    const failed = steps.filter((x) => x.error).length;
    // Within a turn, a section per skill the agent started, so a long
    // unattended run reads as setup, import, build, serve.
    const marks = (summary?.phases ?? []).filter((p) => /^(skill|phase|stage) /.test(p.label) && p.at > (timed[0]?.at ?? 0) && p.at <= (timed.at(-1)?.at ?? 0));
    let body;
    if (!marks.length) body = htmlItems(t, turn.items, seen, pages, byTarget);
    else {
      const parts = [{ label: null, items: [] }];
      for (const it of turn.items) {
        while (marks.length && !Number.isNaN(it.at) && it.at >= marks[0].at) parts.push({ label: marks.shift(), items: [] });
        parts.at(-1).items.push(it);
      }
      body = parts.filter((p) => p.items.length).map((p) => {
        if (!p.label) return htmlItems(t, p.items, seen, pages, byTarget);
        const st = stepsUnder(t, p.items, new Set(seen));
        const f = st.filter((x) => x.error).length;
        const fl = [...p.items, ...st].filter((x) => byTarget.has(x.sid ?? x.mid)).length;
        return `<details class="phase" open><summary>${esc(p.label.label)} <small>${clock(p.label.at)} · ${fmt(p.label.workingMs)} · ${st.length} steps${f ? ` · ${f} failed` : ""}${fl ? ` · ${fl} flagged` : ""}</small></summary>\n${htmlItems(t, p.items, seen, pages, byTarget)}\n</details>`;
      }).join("\n");
    }
    return `<details class="turn" id="turn${i + 1}"${i < 2 || flagged || failed ? " open" : ""}><summary>Turn ${i + 1} <small>${clock(timed[0]?.at)} · ${fmt(working)} · ${steps.length} steps${failed ? ` · ${failed} failed` : ""}${flagged ? ` · ${flagged} flagged` : ""}</small> — ${esc(oneLine(opener?.text ?? "", 110))}</summary>\n${body}\n</details>`;
  });
  const orphans = [...t.agents.keys()].filter((id) => !seen.has(id)).map((id) => {
    const a = t.agents.get(id);
    seen.add(id);
    return `<details class="sub"><summary>subagent <b>${esc(a.type)}</b>: ${esc(a.description)} <small>(not matched to a call)</small></summary>\n${htmlItems(t, grouped(a.items), seen, pages, byTarget)}\n</details>`;
  });

  const s = summary ?? {};
  const head = [];
  if (summary) {
    const ss = s.session;
    head.push(`<p class="m">${esc(ss.id)} · ${esc(ss.harness)}${ss.version ? ` ${esc(ss.version)}` : ""} · ${esc(ss.model ?? "")} · ${esc(ss.cwd ?? "")}${s.prototypes?.length ? ` · ${esc(s.prototypes.map((p) => `${p.codebase}/${p.slug}`).join(", "))}` : ""} · times UTC</p>`);
    head.push(`<p><b>${fmt(s.activeMs)} working</b> of ${fmt(s.wallMs)} (${fmt(s.waitingOnPersonMs)} waiting on the person) · ${s.counts.toolCalls} steps, ${s.counts.errors} failed · ${s.counts.subagents} subagents · ${s.counts.personMessages} messages from the person · ${Math.round(s.usage.output / 1000)}k tokens out, peak context ${Math.round(s.usage.peakContext / 1000)}k</p>`);
    const shown = flags.filter((f) => f.kind !== "phase");
    head.push(`<details open><summary><b>Flags</b> <small>(${shown.length})</small></summary>${shown.length ? table(["", "Where", "What", "By"], shown.map((f) => [`<b>${esc(f.kind)}</b>`, f.target === "session" ? "session" : `<a href="#${esc(f.target)}">${esc(f.target)}</a>`, esc(f.note), `<small>${esc(f.by ?? "")} · ${esc(f.id)}</small>`])) : `<p class="m">None yet. Flag a step or message with <code>trace.mjs flag ${esc(ss.id.slice(0, 8))} s12 --kind improve --note "…"</code>.</p>`}</details>`);
    head.push(`<details open><summary><b>Where the time went</b></summary>${table(["Start", "Phase", "Working", "Wall", "Steps", "Failed"], s.phases.map((p) => [clock(p.at), esc(p.label), fmt(p.workingMs), fmt(p.ms), p.toolCalls, p.errors || ""]), [2, 3, 4, 5])}
<details><summary>by tool</summary>${table(["Tool", "Calls", "Failed", "Total", "Longest"], s.groups.filter((g) => !g.group.startsWith("waiting")).slice(0, 25).map((g) => [esc(g.group), g.calls, g.errors || "", fmt(g.ms), fmt(g.maxMs)]), [1, 2, 3, 4])}</details>
<details><summary>slowest steps</summary>${table(["Step", "Took", "Tool", "What"], s.slowest.map((x) => [sid(x.n), fmt(x.ms), esc(x.group), `<code>${esc(x.label.slice(0, 100))}</code>`]), [1])}</details>
${s.agents.length > 1 ? `<details><summary>subagents</summary>${table(["Agent", "Task", "Wall", "Steps", "Failed", "Ended with"], s.agents.filter((g) => g.id !== "main").map((g) => [esc(g.type), esc(g.description), fmt(g.wallMs), g.toolCalls, g.errors || "", `<small>${esc(g.ended.slice(0, 160))}</small>`]), [2, 3, 4])}</details>` : ""}</details>`);
    head.push(`<details><summary><b>Signals</b> <small>(${s.struggles.length}, found by rule, not read; a starting point)</small></summary><ul>${s.struggles.map((x) => `<li><b>${esc(x.severity)}</b> ${esc(x.title)}${x.costMs ? ` — ${fmt(x.costMs)}` : ""}${x.steps.length ? ` (${x.steps.slice(0, 10).map(sid).join(", ")}${x.steps.length > 10 ? ", …" : ""})` : ""}${x.detail ? `<br><small>${esc(oneLine(x.detail, 300))}</small>` : ""}</li>`).join("")}</ul></details>`);
  }

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace ${esc((t.meta.sessionId ?? "").slice(0, 8))}</title>
${PAGE_STYLE}
<h1>Trace</h1>
${head.join("\n")}
<h2>Conversation <small>${turns.length} turns · each step links to its full input and output</small></h2>
${turns.join("\n")}
${orphans.join("\n")}
<script>
// A link to a step or message opens it and every section around it.
function show(){const e=document.getElementById(decodeURIComponent(location.hash.slice(1)));for(let d=e;d;d=d.parentElement)if(d.tagName==="DETAILS")d.open=true;e&&e.scrollIntoView({block:"center"})}
addEventListener("hashchange",show);if(location.hash)show();
</script>
`;
  return { html, pages };
}

/** transcript.md: the same transcript for an agent to read, ids and flags
 *  included, nothing cut. */
export function transcriptMarkdown(dir, { trace, flags = [] } = {}) {
  const t = numberTranscript(readTranscript(dir), trace);
  const byTarget = flagsByTarget(flags);
  const seen = new Set(["main"]);
  const fence = (s) => {
    const body = String(s ?? "");
    const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    return `${ticks}\n${body}\n${ticks}`;
  };
  const flagLines = (id) => (byTarget.get(id) ?? []).map((f) => `> FLAG ${f.id} ${f.kind}: ${f.note}${f.by ? ` (${f.by})` : ""}\n`).join("");
  const items = (list, depth) => {
    const out = [];
    for (const it of list) {
      const time = clock(it.at);
      if (it.kind === "person" || it.kind === "task" || it.kind === "text") out.push(`**${it.mid} · ${{ person: it.queued ? "Person (while the agent worked)" : "Person", task: "Task", text: "Agent" }[it.kind]} · ${time}**\n\n${it.text.trim()}\n${flagLines(it.mid)}`);
      else if (it.kind === "background") out.push(`**${it.mid} · Background · ${time}**\n\n${fence(it.text.trim())}\n${flagLines(it.mid)}`);
      else if (it.kind === "harness-run") out.push(`*${time} · harness: ${[...new Set(it.items.map((x) => x.label ?? "message"))].join(", ")}*\n\n${it.items.map((x) => fence(x.body ?? x.text ?? "")).join("\n")}\n`);
      else if (it.kind === "thinking") out.push(it.hidden ? "" : `*thinking · ${time}*\n\n> ${it.text.trim().replace(/\n/g, "\n> ")}\n`);
      else if (it.kind === "event") out.push(`*${time} · ${it.label}*\n`);
      else if (it.kind === "tool") {
        out.push(`**${it.sid} · ${it.name} · ${time} · ${fmt(span(it.at, it.end))}${it.error ? " · FAILED" : ""}${it.output == null ? " · no result" : ""}**\n${flagLines(it.sid)}\n${fence(inputBody(it))}\n\n${fence(it.output ?? "(no result recorded)")}\n${it.stderr ? `\nstderr:\n\n${fence(it.stderr)}\n` : ""}`);
        if (it.subagent && t.agents.has(it.subagent) && !seen.has(it.subagent)) {
          const a = t.agents.get(it.subagent);
          seen.add(it.subagent);
          out.push(`${"#".repeat(Math.min(6, depth + 3))} Subagent ${a.type}: ${a.description}\n\n${items(grouped(a.items), depth + 1)}\n*end of subagent ${a.type}*\n`);
        }
      }
    }
    return out.filter(Boolean).join("\n");
  };
  const turns = turnsOf(t.agents.get("main").items).map((turn, i) => `## Turn ${i + 1}\n\n${items(turn.items, 0)}`);
  const rest = [...t.agents.keys()].filter((id) => !seen.has(id)).map((id) => {
    const a = t.agents.get(id);
    seen.add(id);
    return `## Subagent ${a.type}: ${a.description} (not matched to a call)\n\n${items(grouped(a.items), 1)}`;
  });
  const sessionFlags = flagLines("session");
  return `# Transcript ${t.meta.sessionId ?? ""}\n\nEverything the session recorded, in order, nothing cut. Times UTC. s12 is the twelfth step (tool call), m3 the third message; flag one with \`trace.mjs flag <session> s12 --kind improve --note "…"\`.\n\n${sessionFlags}\n${turns.join("\n\n")}\n${rest.join("\n")}`;
}
