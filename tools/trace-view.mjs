/**
 * trace.html: one session on one page, opened straight from disk. A
 * timeline with a lane per agent (long waits folded so work stays
 * readable), the struggles, where the time went, every step with its
 * input and output, and the conversation. Self-contained: the data is
 * inlined and nothing is fetched.
 */
const KEEP = 1500;

const cut = (s, n = KEEP) => (s && s.length > n ? s.slice(0, n) + `\n… [${s.length - n} more chars; trace.mjs show for all of it]` : s ?? "");

export function traceHtml(trace, summary) {
  const data = {
    summary,
    agents: trace.agents.map((a) => ({ id: a.id, type: a.type, description: a.description, firstAt: a.firstAt, lastAt: a.lastAt })),
    tools: trace.tools.map((t) => ({ n: t.n, agent: t.agent, name: t.name, group: t.group, label: t.label, at: t.at, end: t.end ?? t.at, ms: t.ms, error: t.error, unfinished: !!t.unfinished, subagent: t.subagent, input: cut(JSON.stringify(t.input, null, 2)), output: cut(t.output), said: cut(trace.requests.find((r) => r.id === t.request)?.text ?? "", 800) })),
    prompts: trace.prompts.filter((p) => p.agent === "main").map((p) => ({ at: p.at, from: p.from, text: cut(p.text, p.from === "person" ? 6000 : 600) })),
    texts: trace.requests.filter((r) => r.agent === "main" && r.text.trim()).map((r) => ({ at: r.end, text: cut(r.text, 6000) })),
  };
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trace ${esc(summary.session.id.slice(0, 8))}</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1c1a;--muted:#6f6b64;--line:#e7e3dc;--accent:#2f5fd0;--bad:#c4372b;--warn:#b7791f;--ok:#2f855a;--model:#9aa3b5;--wait:#e9e6e0;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--panel:#1f1e1c;--ink:#ecebe8;--muted:#9c978f;--line:#33312d;--accent:#7aa2ff;--bad:#ff6b5e;--warn:#e0a33a;--ok:#5fcf8f;--model:#59606e;--wait:#2a2926}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.45}
main{max-width:1280px;margin:0 auto;padding:20px 16px 80px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 10px}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:8px 12px}.stat b{display:block;font-size:17px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.sev{display:inline-block;min-width:54px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.sev.high{color:var(--bad)}.sev.medium{color:var(--warn)}.sev.low{color:var(--muted)}
.struggle{padding:6px 0;border-bottom:1px solid var(--line)}.struggle:last-child{border:0}.struggle .d{color:var(--muted);font-size:12px;margin-left:58px;word-break:break-word}
a.step{color:var(--accent);cursor:pointer;text-decoration:none}
.bar{display:flex;height:22px;border-radius:6px;overflow:hidden;border:1px solid var(--line)}.bar span{height:100%}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:8px;font-size:12px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
#tl{position:relative;overflow-x:auto}#tl svg{display:block}
.tabs{display:flex;gap:4px;margin:28px 0 10px;border-bottom:1px solid var(--line)}.tabs button{background:none;border:0;border-bottom:2px solid transparent;padding:8px 12px;color:var(--muted);font:inherit;cursor:pointer}.tabs button.on{color:var(--ink);border-color:var(--accent)}
.filters{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px}.filters input[type=search]{flex:1;min-width:200px;padding:7px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);font:inherit}
select{padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);font:inherit}
.row{border-bottom:1px solid var(--line);padding:6px 4px;cursor:pointer;display:grid;grid-template-columns:52px 64px 70px minmax(0,1fr);gap:8px;align-items:baseline}.row:hover{background:var(--wait)}.row.err .t{color:var(--bad)}
.row .l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.row.open .l{white-space:normal;word-break:break-word}
.detail{grid-column:1/-1;cursor:auto}.detail pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px;max-height:420px;overflow:auto;margin:6px 0}
.flash{animation:fl 1.6s}@keyframes fl{0%{background:color-mix(in srgb,var(--accent) 30%,transparent)}100%{background:transparent}}
.msg{margin:10px 0;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel);white-space:pre-wrap;word-break:break-word}.msg.person{border-left:3px solid var(--accent)}.msg.harness,.msg.background{color:var(--muted);font-size:12px}.msg h4{margin:0 0 4px;font-size:12px;color:var(--muted);font-weight:600}
.cstep{font-size:12px;padding:2px 0 2px 12px;color:var(--muted)}.cstep.err{color:var(--bad)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line);font-size:13px}td.r,th.r{text-align:right}
@media (max-width:640px){.row{grid-template-columns:44px 56px minmax(0,1fr)}.row .g{display:none}}
</style>
</head>
<body>
<main>
<h1>Trace <span class="mono">${esc(summary.session.id)}</span></h1>
<div class="muted" id="sub"></div>
<div class="stats" id="stats"></div>
<h2>Struggles</h2><div class="card" id="struggles"></div>
<h2>Where the main session's time went</h2><div class="card"><div class="bar" id="bar"></div><div class="legend" id="legend"></div></div>
<h2>Timeline</h2><div class="card"><div class="muted" style="font-size:12px;margin-bottom:6px">One lane per agent. Grey is the model, coloured bars are tool calls, red ones failed. Waits over two minutes are folded (⋯). Click a bar to open the step.</div><div id="tl"></div></div>
<div class="tabs"><button class="on" data-tab="steps">Steps</button><button data-tab="chat">Conversation</button><button data-tab="tools">Tools</button><button data-tab="agents">Agents</button></div>
<section id="steps"><div class="filters"><input type="search" id="q" placeholder="Filter steps: text in the command, input or output"><select id="agent"></select><label><input type="checkbox" id="failed"> failed only</label><label><input type="checkbox" id="slow"> over 30s</label><span class="muted" id="count"></span></div><div id="rows"></div></section>
<section id="chat" hidden></section>
<section id="tools" hidden></section>
<section id="agents" hidden></section>
</main>
<script>
const D=${json};
const S=D.summary;
const $=s=>document.querySelector(s);
const h=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
const fmt=n=>n==null?"–":n>=3600e3?(n/3600e3).toFixed(1)+"h":n>=60e3?Math.floor(n/60e3)+"m"+String(Math.round(n%60e3/1e3)).padStart(2,"0")+"s":(n/1e3).toFixed(1)+"s";
const clock=t=>new Date(t).toISOString().slice(11,19);
const palette=["#4c78a8","#f58518","#54a24b","#b279a2","#e45756","#72b7b2","#eeca3b","#9d755d","#ff9da6","#79706e","#bab0ac","#59a14f"];
const groups=[...new Set(D.tools.map(t=>t.group))].sort((a,b)=>(S.groups.find(g=>g.group===b)?.ms||0)-(S.groups.find(g=>g.group===a)?.ms||0));
const color=g=>g.startsWith("model")?"var(--model)":g.startsWith("waiting")?"var(--wait)":palette[groups.indexOf(g)%palette.length];
const s=S.session;
$("#sub").textContent=s.harness+(s.version?" "+s.version:"")+" · "+(s.model||"?")+" · "+(s.cwd||"")+" · "+s.firstAt.replace("T"," ").slice(0,19)+" UTC"+(S.prototypes.length?" · "+S.prototypes.map(p=>p.codebase+"/"+p.slug).join(", "):"");
[["working",fmt(S.activeMs)],["wall clock",fmt(S.wallMs)],["waiting on the person",fmt(S.waitingOnPersonMs)],["tool calls",S.counts.toolCalls],["failed",S.counts.errors],["subagents",S.counts.subagents],["model requests",S.counts.modelRequests],["output tokens",Math.round(S.usage.output/1000)+"k"],["peak context",Math.round(S.usage.peakContext/1000)+"k"]].forEach(([k,v])=>{const e=h("div","stat");e.append(h("b",null,v),h("span","muted",k));$("#stats").append(e)});
const st=$("#struggles");if(!S.struggles.length)st.textContent="Nothing flagged.";
for(const x of S.struggles){const e=h("div","struggle");e.append(h("span","sev "+x.severity,x.severity),document.createTextNode(x.title+(x.costMs?" — "+fmt(x.costMs):"")+" "));x.steps.slice(0,10).forEach(n=>{const a=h("a","step","#"+n);a.onclick=()=>openStep(n);e.append(a,document.createTextNode(" "))});if(x.detail)e.append(h("div","d",x.detail));st.append(e)}
const B=Object.entries(S.mainBuckets).sort((a,b)=>b[1]-a[1]);const tot=B.reduce((n,[,v])=>n+v,0)||1;
for(const [k,v] of B){const sp=h("span");sp.style.width=(100*v/tot)+"%";sp.style.background=color(k);sp.title=k+": "+fmt(v);$("#bar").append(sp)}
for(const [k,v] of B.slice(0,14)){const e=h("span");const i=h("i");i.style.background=color(k);e.append(i,document.createTextNode(k+" "+fmt(v)+" ("+Math.round(100*v/tot)+"%)"));$("#legend").append(e)}
// Timeline with folded waits
(function(){const FOLD=120e3,FW=14,lane=26,top=22;const pts=[];for(const a of D.agents)pts.push([a.firstAt,a.lastAt]);for(const t of D.tools)pts.push([t.at,t.end]);
const t0=Math.min(...pts.map(p=>p[0])),t1=Math.max(...pts.map(p=>p[1]));
// busy intervals merged across agents; gaps beyond FOLD get folded
const iv=[...D.tools.map(t=>[t.at,Math.max(t.end,t.at+1)]),...D.prompts.map(p=>[p.at,p.at+1]),...D.texts.map(p=>[p.at,p.at+1])].sort((a,b)=>a[0]-b[0]);const folds=[];let cur=t0;for(const [a,b] of iv){if(a-cur>FOLD)folds.push([cur+FOLD/4,a-FOLD/4]);cur=Math.max(cur,b)}if(t1-cur>FOLD)folds.push([cur+FOLD/4,t1]);
const kept=(t1-t0)-folds.reduce((n,[a,b])=>n+(b-a),0);const W=Math.max(900,document.querySelector("#tl").clientWidth||900),avail=W-150-folds.length*FW;const k=avail/Math.max(kept,1);
const X=t=>{let x=150,prev=t0;for(const [a,b] of folds){if(t<=a)break;x+=(Math.min(t,a)-prev)*k;if(t<b)return x+FW*(t-a)/(b-a);x+=FW;prev=b}return x+(t-prev)*k};
const ns="http://www.w3.org/2000/svg",H=top+lane*D.agents.length+8,svg=document.createElementNS(ns,"svg");svg.setAttribute("width",W);svg.setAttribute("height",H);
const el=(n,a)=>{const e=document.createElementNS(ns,n);for(const k in a)e.setAttribute(k,a[k]);return e};
for(const [a,b] of folds){const x=X(a);svg.append(el("rect",{x,y:top-4,width:FW,height:H-top,fill:"var(--wait)"}));const t=el("text",{x:x+2,y:top-8,"font-size":10,fill:"var(--muted)"});t.textContent="⋯";const ti=document.createElementNS(ns,"title");ti.textContent="folded "+fmt(b-a);t.append(ti);svg.append(t)}
const span=t1-t0;const step=[60e3,300e3,600e3,1800e3,3600e3].find(s=>kept/s<14)||7200e3;for(let t=Math.ceil(t0/step)*step;t<t1;t+=step){if(folds.some(([a,b])=>t>a&&t<b))continue;const x=X(t);svg.append(el("line",{x1:x,x2:x,y1:top-2,y2:H,stroke:"var(--line)"}));const tx=el("text",{x:x+2,y:12,"font-size":10,fill:"var(--muted)"});tx.textContent=clock(t).slice(0,5);svg.append(tx)}
D.agents.forEach((a,i)=>{const y=top+i*lane;const lb=el("text",{x:4,y:y+15,"font-size":11,fill:"var(--ink)"});lb.textContent=(a.id==="main"?"main":a.type+" "+a.id.slice(0,6)).slice(0,22);const ti=document.createElementNS(ns,"title");ti.textContent=a.description;lb.append(ti);svg.append(lb);
svg.append(el("rect",{x:X(a.firstAt),y:y+9,width:Math.max(1,X(a.lastAt)-X(a.firstAt)),height:4,fill:"var(--model)",rx:2}));
for(const t of D.tools.filter(t=>t.agent===a.id)){const x=X(t.at),w=Math.max(2,X(t.end)-x);const r=el("rect",{x,y:y+3,width:w,height:16,rx:2,fill:t.error?"var(--bad)":color(t.group),opacity:t.name==="Agent"||t.name==="Task"?.35:.9,style:"cursor:pointer"});const ti=document.createElementNS(ns,"title");ti.textContent="#"+t.n+" "+t.group+" "+fmt(t.ms)+(t.error?" FAILED":"")+"\\n"+t.label;r.append(ti);r.onclick=()=>openStep(t.n);svg.append(r)}
for(const p of a.id==="main"?D.prompts.filter(p=>p.from==="person"):[]){const x=X(p.at);svg.append(el("line",{x1:x,x2:x,y1:y,y2:y+22,stroke:"var(--accent)","stroke-width":2}))}});
$("#tl").append(svg)})();
// Steps
const sel=$("#agent");sel.append(new Option("all agents",""));for(const a of D.agents)sel.append(new Option(a.id==="main"?"main":a.type+" "+a.id.slice(0,8),a.id));
function render(){const q=$("#q").value.toLowerCase(),ag=sel.value,f=$("#failed").checked,sl=$("#slow").checked;const rows=$("#rows");rows.textContent="";let n=0;
for(const t of D.tools){if(ag&&t.agent!==ag)continue;if(f&&!t.error)continue;if(sl&&!(t.ms>=30e3))continue;if(q&&!(t.label+"\\n"+t.input+"\\n"+t.output+"\\n"+t.group).toLowerCase().includes(q))continue;if(++n>1500)break;
const r=h("div","row"+(t.error?" err":""));r.id="s"+t.n;r.append(h("span","mono muted","#"+t.n),h("span","mono t",fmt(t.ms)+(t.error?" ✕":"")),h("span","g muted",t.agent==="main"?"main":t.agent.slice(0,6)),h("span","l mono",t.group===t.name?t.name+" · "+t.label:t.group+" · "+t.label));r.onclick=e=>{if(e.target.closest(".detail"))return;toggle(r,t)};rows.append(r)}
$("#count").textContent=n+" of "+D.tools.length}
function toggle(r,t){const d=r.querySelector(".detail");if(d){d.remove();r.classList.remove("open");return}r.classList.add("open");const x=h("div","detail");x.append(h("div","muted",clock(t.at)+" · "+t.name+(t.unfinished?" · never returned":"")+(t.subagent?" · subagent "+t.subagent:"")));if(t.said){x.append(h("div","muted","model said:"),h("pre",null,t.said))}x.append(h("div","muted","input"),h("pre",null,t.input),h("div","muted","output"),h("pre",null,t.output||"(empty)"));r.append(x)}
function openStep(n){tab("steps");$("#q").value="";$("#failed").checked=false;$("#slow").checked=false;sel.value="";render();const r=$("#s"+n);if(!r)return;const t=D.tools.find(t=>t.n===n);if(!r.querySelector(".detail"))toggle(r,t);r.scrollIntoView({block:"center"});r.classList.add("flash");setTimeout(()=>r.classList.remove("flash"),1700)}
["#q","#agent","#failed","#slow"].forEach(s=>$(s).addEventListener("input",render));render();
// Conversation
(function(){const c=$("#chat");const items=[...D.prompts.map(p=>({at:p.at,p})),...D.texts.map(x=>({at:x.at,x})),...D.tools.filter(t=>t.agent==="main").map(t=>({at:t.at,t}))].sort((a,b)=>a.at-b.at);
for(const it of items){if(it.p){const m=h("div","msg "+it.p.from);m.append(h("h4",null,(it.p.from==="person"?"Person":it.p.from==="background"?"Background":"Harness")+" · "+clock(it.at)),document.createTextNode(it.p.text.trim()));c.append(m)}else if(it.x){const m=h("div","msg");m.append(h("h4",null,"Agent · "+clock(it.at)),document.createTextNode(it.x.text.trim()));c.append(m)}else{const t=it.t,e=h("div","cstep mono"+(t.error?" err":""));const a=h("a","step","#"+t.n);a.onclick=()=>openStep(t.n);e.append(a,document.createTextNode(" "+clock(t.at)+" "+t.name+" "+fmt(t.ms)+(t.error?" ✕ ":" ")+t.label.slice(0,150)));c.append(e)}}})();
// Tools + agents tables
(function(){const tb=h("table");tb.innerHTML="<tr><th>Tool</th><th class=r>Calls</th><th class=r>Failed</th><th class=r>Total</th><th class=r>Longest</th></tr>";for(const g of S.groups){const r=h("tr");[g.group,g.calls,g.errors,fmt(g.ms),fmt(g.maxMs)].forEach((v,i)=>{const d=h("td",i?"r":"",v);r.append(d)});tb.append(r)}$("#tools").append(tb);
const ta=h("table");ta.innerHTML="<tr><th>Agent</th><th>Task</th><th class=r>Wall</th><th class=r>Steps</th><th class=r>Failed</th><th class=r>Out tokens</th></tr>";for(const a of S.agents){const r=h("tr");[a.id==="main"?"main":a.type+" "+a.id.slice(0,8),a.description,fmt(a.wallMs),a.toolCalls,a.errors,Math.round(a.outputTokens/1000)+"k"].forEach((v,i)=>r.append(h("td",i>1?"r":"",v)));ta.append(r)}$("#agents").append(ta)})();
function tab(n){document.querySelectorAll(".tabs button").forEach(b=>b.classList.toggle("on",b.dataset.tab===n));for(const id of ["steps","chat","tools","agents"])$("#"+id).hidden=id!==n}
document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>tab(b.dataset.tab));
</script>
</body>
</html>
`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
