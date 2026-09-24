// Point this at any open tab. It reads the layout tree and writes a
// wireframe page: one labeled, depth-colored box per element, with a
// depth slider. This is the first artifact of every run. It shows the
// raw structure before the agent curates it.
// Usage: node tools/wireframe.mjs <tab-url-substring> [out.html] [port]
import { writeFileSync } from "node:fs";
import { findPage } from "./attach.mjs";
import { connect, evaluate } from "./cdp.mjs";

const GRAB = `(() => {
  function grab(el) {
    const r = el.getBoundingClientRect();
    // zero-size is not empty: display:contents wrappers report 0x0 but
    // their children lay out normally: descend without emitting a node
    if (r.width < 5 || r.height < 5) return [...el.children].flatMap(grab);
    const cls = (typeof el.className === "string" ? el.className : "")
      .split(" ").filter(x => x && !x.includes(":")).slice(0, 2).join(" ");
    const kids = [...el.children].flatMap(grab);
    let text = null;
    if (kids.length === 0 && el.innerText) text = el.innerText.slice(0, 30);
    return [{ tag: el.tagName.toLowerCase(), cls, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, text, children: kids }];
  }
  return JSON.stringify({ viewport: [innerWidth, innerHeight], tree: grab(document.body)[0] });
})()`;

const match = process.argv[2];
const out = process.argv[3] || "wireframe.html";
const port = Number(process.argv[4] || 9333);
if (!match) {
  console.error("Usage: node tools/wireframe.mjs <tab-url-substring> [out.html] [port]");
  process.exit(1);
}

const tab = await findPage(match, port);
if (!tab) {
  console.error(`no open tab matches "${match}" on port ${port}`);
  process.exit(1);
}
const page = await connect(tab.webSocketDebuggerUrl);
const data = JSON.parse(await evaluate(page, GRAB));
page.close();

let boxes = "";
let maxDepth = 0;
function walk(n, d) {
  maxDepth = Math.max(maxDepth, d);
  const hue = (d * 47) % 360;
  let label = n.tag;
  if (n.cls) label += "." + n.cls.split(" ")[0];
  boxes += `<div class="b" data-d="${d}" style="left:${n.rect.x}px; top:${n.rect.y}px; width:${n.rect.w}px; height:${n.rect.h}px; outline:1px solid hsl(${hue} 80% 40%); background:hsl(${hue} 70% 60% / 0.18);"><i>${label}</i></div>\n`;
  for (const k of n.children) walk(k, d + 1);
}
walk(data.tree, 0);

writeFileSync(out, `<!doctype html>
<meta charset="utf-8">
<title>wireframe: ${tab.url.slice(0, 60)}</title>
<body style="margin:0; font-family:monospace;">
<div style="position:relative;">
${boxes}</div>
<div style="position:fixed; right:12px; bottom:12px; z-index:99; background:#111; color:#eee; font-size:12px; padding:8px 12px; border-radius:8px;">
  depth <input type="range" min="0" max="${maxDepth}" value="${maxDepth}"
    oninput="l.textContent=this.value; for (const b of document.querySelectorAll('.b')) b.style.display = +b.dataset.d > +this.value ? 'none' : 'block'"
    style="vertical-align:middle;"> <span id="l">${maxDepth}</span>
</div>
<style>
  .b { position: absolute; }
  .b i { font-style: normal; font-size: 9px; color: #fff; padding: 0 3px; position: absolute; top: 0; left: 0; background: inherit; }
</style>
`);
console.log(`viewport ${data.viewport.join("x")}, maxDepth ${maxDepth} -> ${out}`);
