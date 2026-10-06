import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { headlessPage } from './cdp/headless.mjs';
import { evaluate } from './cdp/cdp.mjs';
const enabled = process.env.PROTO_SCREENSHOT_BROWSER_TEST === '1';
test('generated preview waits for delayed mounting and image decoding before measurement', { skip: !enabled }, async t => {
  const server = createServer((req, res) => {
    if (req.url === '/image.svg') { setTimeout(() => { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>'); }, 300); return; }
    res.setHeader('Content-Type', 'text/html'); res.end(`<div id="root"></div><script>setTimeout(()=>{document.querySelector('#root').innerHTML='<main data-proto-id="main"><img src="/image.svg"></main>'},400)</script>`);
  }).listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const start = Date.now(); const tab = await headlessPage(`http://127.0.0.1:${server.address().port}`, { width: 200, height: 200, display: { dpr: 1, colorProfile: 'srgb' }, generated: true, markers: ['main'] });
  try { assert.ok(Date.now() - start >= 700); assert.equal(await evaluate(tab.page, 'document.images[0].naturalWidth'), 40); } finally { await tab.close(); }
});
test('generated preview surfaces early runtime failures before comparison', { skip: !enabled }, async t => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script>throw new Error("fixture import failed")</script>'); }).listen(0,'127.0.0.1');
  await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  await assert.rejects(headlessPage(`http://127.0.0.1:${server.address().port}`, { width: 200, height: 200, display: { dpr: 1, colorProfile: 'srgb' }, generated: true }), error => error.name === 'RenderError' && error.diagnostics.some(line => line.includes('fixture import failed')));
});
