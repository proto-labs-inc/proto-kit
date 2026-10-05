/**
 * trace.html: the analysis of one session as a plain page, the same
 * numbers as report.md. Every step number links to that step in
 * transcript.html, where its full input and output are one click away.
 */
import { duration as fmt } from "./trace-read.mjs";
import { PAGE_STYLE } from "./trace-transcript.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clock = (t) => new Date(t).toISOString().slice(11, 19);
const pct = (v, total) => (total ? `${Math.round((100 * v) / total)}%` : "–");

function table(head, rows) {
  return `<table>\n<tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>\n${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("\n")}\n</table>`;
}

function buckets(b, total) {
  return table(["Where", "Time", "Share"], Object.entries(b).sort((x, y) => y[1] - x[1]).filter(([, v]) => v >= 1000).map(([k, v]) => [esc(k), fmt(v), pct(v, total)]));
}

export function traceHtml(trace, a) {
  const s = a.session;
  const ids = new Map(trace.tools.map((t) => [t.n, t.id]));
  const step = (n) => (ids.get(n) ? `<a href="transcript.html#t-${esc(ids.get(n))}">${n}</a>` : String(n));
  const steps = (list) => (list.length ? ` (steps ${list.slice(0, 12).map(step).join(", ")}${list.length > 12 ? ", …" : ""})` : "");
  const out = [];
  out.push(`<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Analysis ${esc(s.id.slice(0, 8))}</title>\n${PAGE_STYLE}`);
  out.push(`<h1>Analysis</h1>`);
  out.push(`<p class="m">${esc(s.id)} · <a href="transcript.html">transcript</a></p>`);
  out.push(`<ul>
<li><b>Harness:</b> ${esc(s.harness)}${s.version ? ` ${esc(s.version)}` : ""}, model ${esc(s.model ?? "?")}</li>
<li><b>Folder:</b> ${esc(s.cwd ?? "?")}</li>
${a.prototypes.length ? `<li><b>Prototypes:</b> ${esc(a.prototypes.map((p) => `${p.codebase}/${p.slug}`).join(", "))}</li>` : ""}
<li><b>Span:</b> ${esc(s.firstAt.replace("T", " ").slice(0, 19))} → ${esc(s.lastAt.slice(11, 19))} UTC, ${fmt(a.wallMs)} wall, <b>${fmt(a.activeMs)} working</b> (${fmt(a.waitingOnPersonMs)} waiting on the person)</li>
<li><b>Work:</b> ${a.counts.toolCalls} tool calls (${a.counts.errors} failed), ${a.counts.modelRequests} model requests, ${a.counts.subagents} subagents, ${a.counts.personMessages} messages from the person, ${a.counts.compactions} compactions</li>
<li><b>Tokens:</b> ${Math.round(a.usage.output / 1000)}k out, ${Math.round(a.usage.input / 1000)}k fresh in, ${Math.round((a.usage.cacheRead / 1e6) * 10) / 10}M cache read, peak context ${Math.round(a.usage.peakContext / 1000)}k</li>
</ul>`);

  out.push(`<h2>Struggles</h2>`);
  out.push(a.struggles.length
    ? `<ul>\n${a.struggles.map((x) => `<li><b>${esc(x.severity)}</b> ${esc(x.title)}${x.costMs ? ` — ${fmt(x.costMs)}` : ""}${steps(x.steps)}${x.detail ? `<br><small>${esc(x.detail.replace(/\s+/g, " ").slice(0, 400))}</small>` : ""}</li>`).join("\n")}\n</ul>`
    : "<p>Nothing flagged.</p>");

  if (a.noted?.length) {
    out.push(`<h2>What the agents noticed</h2>\n<p class="m">Sentences where an agent said something went wrong. Kit bugs that exit cleanly but do the wrong thing often show only here.</p>`);
    out.push(`<ul>\n${a.noted.slice(0, 40).map((x) => `<li><small>${clock(x.at)}${x.agent !== "main" ? ` ${esc(x.agent.slice(0, 8))}` : ""}</small> ${esc(x.text)}${x.step ? ` (before step ${step(x.step)})` : ""}</li>`).join("\n")}\n</ul>`);
  }

  out.push(`<h2>Where the main session's time went</h2>\n${buckets(a.mainBuckets, a.wallMs)}`);

  if (a.agents.length > 1) {
    const total = Object.values(a.workBuckets).reduce((n, v) => n + v, 0);
    out.push(`<h2>All work, main and subagents together</h2>\n<p class="m">Each agent's own time added up, without waiting. Subagents run alongside the main session, so this can be more than the wall clock.</p>\n${buckets(a.workBuckets, total)}`);
    out.push(`<h2>Subagents</h2>\n${table(["Agent", "Task", "Wall", "Steps", "Failed", "Ended with"], a.agents.filter((g) => g.id !== "main").map((g) => [`${esc(g.type)} <small>${esc(g.id.slice(0, 8))}</small>`, esc(g.description), fmt(g.wallMs), g.toolCalls, g.errors, `<small>${esc(g.ended.slice(0, 200))}</small>`]))}`);
  }

  out.push(`<h2>Phases</h2>\n<p class="m">Each starts at a message from the person or a skill starting, and runs to the next.</p>\n${table(["Start", "Phase", "Working", "Wall", "Steps", "Failed"], a.phases.map((p) => [clock(p.at), esc(p.label), fmt(p.workingMs), fmt(p.ms), p.toolCalls, p.errors]))}`);
  out.push(`<h2>Tools</h2>\n${table(["Tool", "Calls", "Failed", "Total", "Longest"], a.groups.filter((g) => !g.group.startsWith("waiting")).map((g) => [esc(g.group), g.calls, g.errors, fmt(g.ms), fmt(g.maxMs)]))}`);
  out.push(`<h2>Slowest steps</h2>\n<ul>\n${a.slowest.map((t) => `<li>step ${step(t.n)} — ${fmt(t.ms)}${t.error ? " <b>failed</b>" : ""} — ${esc(t.group)}${t.agent !== "main" ? ` <small>(${esc(t.agent.slice(0, 8))})</small>` : ""}: <code>${esc(t.label.slice(0, 140))}</code></li>`).join("\n")}\n</ul>`);
  return out.join("\n\n") + "\n";
}
