#!/usr/bin/env node
/** Verify a built migration candidate without publishing or editing the original. */
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { headlessPage, stopSessionRenderer } from "./cdp/headless.mjs";

const workspace = resolve(process.argv[2] ?? "");
const root = await realpath(join(workspace, "dist"));
const manifest = JSON.parse(await readFile(join(workspace, "public", "prototype.json"), "utf8"));
const session = join(workspace, ".proto-checks", "rig-browser.json");
process.env.PROTO_BROWSER_SESSION = session;
const types = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/__rig_check") {
      const search = url.searchParams.get("search") || "";
      const frameUrl = `/${search}`;
      res.setHeader("Content-Type", "text/html");
      res.end(`<script>window.addEventListener('message',e=>{const f=document.querySelector('iframe');if(e.source===f?.contentWindow&&e.origin===location.origin&&e.data?.type==='hello')window.rigHello=e.data})</script><iframe style="width:1280px;height:800px" src=${JSON.stringify(frameUrl).replaceAll('<','&lt;')}></iframe>`);
      return;
    }
    let file = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (file !== root && !file.startsWith(root + sep)) throw new Error("Invalid path");
    if (!extname(file)) file = join(root, "index.html");
    file = await realpath(file);
    if (!file.startsWith(root + sep)) throw new Error("Invalid path");
    res.setHeader("Content-Type", types[extname(file)] || "application/octet-stream");
    res.end(await readFile(file));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = `http://127.0.0.1:${server.address().port}`;
const views = [{ name: "initial", search: "" }, ...manifest.states.map(state => ({ name: state.id, search: `?state=${encodeURIComponent(state.id)}` }))];
for (const set of manifest.variantSets ?? []) {
  for (const variant of set.variants ?? []) {
    const params = new URLSearchParams();
    const seen = new Set();
    const select = (component, value) => {
      if (seen.has(component)) throw new Error("Cyclic alternate dependency");
      seen.add(component); params.set(`v.${component}`, value);
      const parent = manifest.variantSets.find(item => item.component === component)?.requires;
      if (parent) select(parent.component, parent.variant);
    };
    select(set.component, variant.id);
    views.push({ name: `${set.component}/${variant.id}`, search: `?${params}` });
  }
}
const checked = [];
try {
  for (const view of views) {
    const opened = await headlessPage(`${address}/__rig_check?search=${encodeURIComponent(view.search)}`, { width: 1280, height: 800 });
    try {
      // Frozen screens use portals outside the React mount. Check rendered
      // content across the document, not children of a particular mount node.
      const result = await opened.page.send("Runtime.evaluate", { awaitPromise: true, returnByValue: true, expression: `(async()=>{
        const end=Date.now()+12000;
        let observation;
        while(Date.now()<end){
          const doc=document.querySelector('iframe')?.contentDocument;
          const body=doc?.body;
          const hello=window.rigHello;
          const alert=body?.querySelector('[role="alert"]')?.textContent;
          const loading=[...(body?.querySelectorAll('[role="status"]')??[])].some(el=>el.textContent.includes('Loading prototype'));
          const rendered=[...(body?.querySelectorAll('*')??[])].some(el=>{
            if(el.closest('script,style,template,noscript,[hidden],[aria-hidden="true"]'))return false;
            const style=doc.defaultView.getComputedStyle(el);
            if(style.visibility==='hidden'||style.display==='none'||style.opacity==='0')return false;
            const rect=el.getBoundingClientRect();
            if(rect.width<=0||rect.height<=0)return false;
            return [...el.childNodes].some(node=>node.nodeType===3&&node.textContent.trim())||el.matches('canvas,img,svg,video,iframe,input,button');
          });
          observation={handshake:hello?.adapterContract===1&&!!hello.runtimeVersion,rendered,loading,alert:alert||null};
          if(observation.handshake&&rendered&&!loading&&!alert)return {hello,search:doc.location.search};
          await new Promise(resolve=>setTimeout(resolve,100));
        }
        throw new Error('Rig startup verification failed: '+JSON.stringify(observation));
      })()` });
      if (result.exceptionDetails || !result.result?.value?.hello?.runtimeVersion) {
        const detail = result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || "no hosted runtime";
        throw new Error(`Candidate failed view ${view.name}: ${detail}`);
      }
      const actual = new URLSearchParams(result.result.value.search);
      for (const [key, value] of new URLSearchParams(view.search)) if (actual.get(key) !== value) throw new Error(`Candidate lost ${key} in ${view.name}`);
      checked.push(view.name);
    } finally { await opened.close(); }
  }
  console.log(JSON.stringify({ status: "startup-verified", views: checked }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await stopSessionRenderer(session).catch(() => {});
}
