/** Render every manifest view of the compiled prototype and verify its bridge. */
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { headlessPage, stopSessionRenderer } from './cdp/headless.mjs';
import { evaluate } from './cdp/cdp.mjs';
import { viewsOf } from './views.mjs';

export async function verifyRigBuild(folder, version) {
  const root = resolve(folder);
  const manifest = JSON.parse(await readFile(join(root, 'prototype.json'), 'utf8'));
  const mime = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/__rig_check') {
        const target = url.searchParams.get('target');
        if (!target?.startsWith('/') || target.startsWith('//')) throw new Error('Invalid target');
        res.setHeader('Content-Type', 'text/html');
        res.end(`<link rel="icon" href="data:,"><script>window.messages=[];window.errors=[];addEventListener('message',e=>{if(e.source===document.querySelector('iframe')?.contentWindow&&e.origin===location.origin)messages.push(e.data)})</script><iframe style="width:100vw;height:100vh;border:0" referrerpolicy="no-referrer"></iframe><script>document.querySelector('iframe').src=${JSON.stringify(target).replace(/</g, '\\u003c')}</script>`);
        return;
      }
      let file = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (file !== root && !file.startsWith(root + sep)) throw new Error('Invalid path');
      if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let opened;
  const previousSession = process.env.PROTO_BROWSER_SESSION;
  const sessionDir = resolve(folder, '../../browser-check');
  await mkdir(sessionDir, { recursive: true });
  process.env.PROTO_BROWSER_SESSION = join(sessionDir, 'browser-session.json');
  const stop = () => stopSessionRenderer(join(sessionDir, 'browser-session.json'));
  const interrupted = () => { void (async () => { await opened?.close().catch(() => {}); await stop().catch(() => {}); process.exit(143); })(); };
  process.once('SIGTERM', interrupted);
  try {
    opened = await headlessPage('about:blank', { width: 1280, height: 900, display: { dpr: 1, colorProfile: 'srgb' } });
    const page = opened.page;
    await page.send('Runtime.enable');
    await page.send('Network.enable');
    const errors = [];
    page.on('Runtime.consoleAPICalled', event => { if (event.type === 'error') errors.push('Console error: ' + event.args.map(arg => arg.value || arg.description || '').join(' ')); });
    page.on('Runtime.exceptionThrown', event => errors.push(event.exceptionDetails?.text || 'Runtime exception'));
    page.on('Network.responseReceived', event => { if (event.response.status >= 400) errors.push(`Asset HTTP ${event.response.status}`); });
    page.on('Network.loadingFailed', event => { if (!event.canceled) errors.push(event.errorText); });
    for (const view of viewsOf(manifest, origin)) {
      errors.length = 0;
      const target = new URL(view.url);
      const loaded = page.once('Page.loadEventFired');
      await page.send('Page.navigate', { url: `${origin}/__rig_check?target=${encodeURIComponent(target.pathname + target.search)}` });
      let timer;
      try { await Promise.race([loaded, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${view.name}: navigation timed out`)), 20000); })]); } finally { clearTimeout(timer); }
      // Require an actual state report, not just an iframe load event.
      const result = await evaluate(page, `new Promise(resolve => {const until=Date.now()+15000;const tick=()=>{const m=window.messages||[];const hello=m.find(x=>x.type==='hello');const state=m.find(x=>x.type==='state-changed');const body=document.querySelector('iframe')?.contentDocument?.body; if(hello&&state&&body?.getBoundingClientRect().height>0&&(body.innerText.trim()||[...body.querySelectorAll('img,canvas,svg,video,input,button')].some(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0})))resolve({version:hello.rigVersion,search:state.search});else if(Date.now()>until)resolve(null);else setTimeout(tick,100)};tick()})`);
      if (!result || result.version !== version) throw new Error(`${view.name}: rig handshake or state report failed`);
      const observed = new URLSearchParams(result.search);
      for (const [key, value] of target.searchParams) if (observed.get(key) !== value) throw new Error(`${view.name}: state did not round-trip (${key})`);
      await evaluate(page, "new Promise(resolve=>setTimeout(resolve,300))");
      if (errors.length) throw new Error(`${view.name}: ${errors.join('; ')}`);
    }
  } finally {
    await opened?.close().catch(() => {});
    await stop();
    process.removeListener('SIGTERM', interrupted);
    if (previousSession === undefined) delete process.env.PROTO_BROWSER_SESSION;
    else process.env.PROTO_BROWSER_SESSION = previousSession;
    await new Promise(resolveClose => server.close(resolveClose));
  }
}
