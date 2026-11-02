// Settling before a capture (tools/cdp/render-profile.mjs settleForCapture),
// in a real browser: PROTO_BROWSER_TEST=1 node --test tools/settle.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate } from "./cdp/cdp.mjs";
import { networkIdle, settleForCapture, settleProblem, trackNetwork } from "./cdp/render-profile.mjs";

const browser = { skip: process.env.PROTO_BROWSER_TEST !== "1", timeout: 180_000 };

// A signed-in SPA in miniature: skeleton rows until its data arrives after
// 800 ms, then header items that tween in from inline `opacity: 0;
// transform` on requestAnimationFrame (as framer-motion does), a card that
// fades in with a long finite CSS transition, and a sync indicator that
// spins forever.
const SPA = `<!doctype html><html><head><style>
  body { margin: 0; font: 16px sans-serif; }
  header { display: flex; gap: 16px; padding: 16px; }
  .skeleton-row { height: 20px; margin: 8px 16px; background: #ddd; }
  .sync { position: fixed; right: 8px; bottom: 8px; width: 16px; height: 16px; background: #09f; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  #card { margin: 16px; width: 300px; height: 120px; background: rgb(200, 30, 30); opacity: 0; transition: opacity 4s linear; }
  #card.shown { opacity: 1; }
</style></head><body>
  <header><nav id="crumbs" style="opacity: 0; transform: translateY(8px)">Acme / Settings</nav>
    <button id="connect" style="opacity: 0; transform: translateY(8px)">Connect</button></header>
  <main id="main"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></main>
  <div id="card"></div>
  <div class="sync" title="Syncing"></div>
  <script>
    const tween = (element, ms) => {
      const start = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - start) / ms);
        element.style.opacity = String(t);
        element.style.transform = 'translateY(' + (8 * (1 - t)) + 'px)';
        if (t < 1) requestAnimationFrame(tick);
        else { element.style.removeProperty('opacity'); element.style.removeProperty('transform'); }
      };
      requestAnimationFrame(tick);
    };
    fetch('/api/org').then(r => r.json()).then(org => {
      document.getElementById('main').innerHTML = '<h1>' + org.name + '</h1><p>General settings</p>';
      tween(document.getElementById('crumbs'), 600);
      setTimeout(() => tween(document.getElementById('connect'), 600), 150);
      requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('card').classList.add('shown')));
    });
  </script></body></html>`;

// Never still: an element a script moves every few milliseconds.
const RESTLESS = `<!doctype html><body><div id="m" style="position:absolute;left:0;width:20px;height:20px;background:#000"></div>
  <script>let x = 0; setInterval(() => { document.getElementById('m').style.left = (x = (x + 1) % 200) + 'px'; }, 5);</script></body>`;

async function serve(t) {
  const server = createServer((req, res) => {
    if (req.url === "/api/org") {
      setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ name: "Acme Org" })); }, 800);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(req.url.startsWith("/restless") ? RESTLESS : SPA);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

async function open(url, t) {
  const { headlessPage } = await import("./cdp/headless.mjs");
  const opened = await headlessPage("about:blank", { width: 1440, height: 900 });
  t.after(() => opened.close());
  const { page } = opened;
  await page.send("Page.enable");
  await trackNetwork(page);
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
  return page;
}

test("network idle needs no request in flight for half a second and ignores long-lived ones", () => {
  const now = 100_000;
  assert.equal(networkIdle(undefined).idle, true);
  assert.equal(networkIdle({ inflight: new Map(), lastActivity: now - 600 }, now).idle, true);
  assert.equal(networkIdle({ inflight: new Map(), lastActivity: now - 100 }, now).idle, false);
  const busy = { inflight: new Map([["1", { at: now - 200, url: "https://x/api" }]]), lastActivity: now - 200 };
  assert.deepEqual(networkIdle(busy, now).pending, ["https://x/api"]);
  const poll = { inflight: new Map([["1", { at: now - 60_000, url: "https://x/poll" }]]), lastActivity: now - 60_000 };
  assert.equal(networkIdle(poll, now).idle, true, "a request open longer than ten seconds is a long poll");
  assert.equal(settleProblem({ settled: true, ms: 10, reasons: [], lingering: [] }, "x"), null);
  assert.match(settleProblem({ settled: false, ms: 15_000, reasons: ["layout still moving (div#m)"], lingering: [] }, "State default at 320px"),
    /State default at 320px did not settle within 15 s: layout still moving/);
});

test("settling waits out data loading and script tweens, fast-forwards finite motion and ignores an infinite spinner", browser, async (t) => {
  const page = await open(await serve(t), t);
  const started = Date.now();
  const result = await settleForCapture(page, evaluate);
  const took = Date.now() - started;
  assert.equal(result.settled, true, result.reasons.join("; "));
  assert.deepEqual(result.lingering, []);
  assert.ok(took >= 700, `waited for the data (${took} ms)`);
  assert.ok(took < 4_000, `did not wait for the 4 s transition or the infinite spinner (${took} ms)`);
  const state = JSON.parse(await evaluate(page, `JSON.stringify({
    skeletons: document.querySelectorAll('.skeleton-row').length,
    heading: document.querySelector('h1')?.textContent,
    crumbs: getComputedStyle(document.getElementById('crumbs')).opacity,
    crumbsStyle: document.getElementById('crumbs').getAttribute('style'),
    connect: getComputedStyle(document.getElementById('connect')).opacity,
    card: getComputedStyle(document.getElementById('card')).opacity,
    spinning: document.getAnimations().some(a => a.playState === 'running' && !Number.isFinite(a.effect.getComputedTiming().endTime)),
  })`));
  assert.deepEqual(state, { skeletons: 0, heading: "Acme Org", crumbs: "1", crumbsStyle: "", connect: "1", card: "1", spinning: true });
});

test("a page that never stops moving is bounded and says why", browser, async (t) => {
  const page = await open(`${await serve(t)}/restless`, t);
  const started = Date.now();
  const result = await settleForCapture(page, evaluate, undefined, { timeoutMs: 1_500 });
  assert.equal(result.settled, false);
  assert.ok(Date.now() - started < 4_000);
  assert.ok(result.reasons.some(reason => /layout still moving \(div#m/.test(reason)), result.reasons.join("; "));
});

test("capture shoots settled references and reports them, the desktop one first", browser, async (t) => {
  const url = await serve(t);
  const dir = mkdtempSync(join(tmpdir(), "proto-settle-capture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { headlessPage } = await import("./cdp/headless.mjs");
  const opened = await headlessPage(`${url}/settings`, { width: 1440, height: 900 });
  t.after(() => opened.close());
  const { capturePlan } = await import("./prepare-plan.mjs");
  const reported = [];
  // No states file: the CLI's default {}.
  const result = await capturePlan({ page: opened.page, url: `${url}/settings`, dir, states: {}, height: 600, lanes: 1,
    onReference: async (reference) => { reported.push(reference); } });
  assert.deepEqual(result.captureProblems, []);
  assert.equal(reported[0].width, Math.max(...result.widths), "the widest reference is reported first");
  assert.equal(reported[0].widest, true);
  assert.deepEqual(reported.map(r => r.width).sort((a, b) => a - b), result.widths);
  // Content, not skeletons: the Connect button is visible (opacity checked) in the inventory,
  // and the card is drawn at full colour.
  const inventory = JSON.parse(readFileSync(join(dir, "inventory.json"), "utf8"));
  for (const width of result.widths)
    assert.ok(inventory.snapshots.default[width].controls.some(c => c.label === "Connect"), `Connect visible at ${width}px`);
  const { decodePng } = await import("./cdp/png.mjs");
  const png = decodePng(readFileSync(reported[0].file));
  const at = (x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 3)];
  const plan = JSON.parse(readFileSync(result.plan, "utf8"));
  const box = JSON.parse(await evaluate(opened.page, "JSON.stringify(document.getElementById('card').getBoundingClientRect())"));
  assert.ok(plan.scenarios.length);
  assert.deepEqual(at(Math.round(box.x + 20), Math.round(box.y + 20)), [200, 30, 30]);
});
