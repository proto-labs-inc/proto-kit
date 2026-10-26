import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { acquireSourceSession, releaseSourceSession, resolveSourceSession } from "./source-session.mjs";
import { connect, evaluate } from "./cdp.mjs";
import { framePaths, takeFrame, frameCrop } from "./live.mjs";
import { readSession } from "./session-context.mjs";

const chrome = process.env.PROTO_TEST_CHROME;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Acceptance: concurrent Home, Playground, and identical-URL builds never share
// a window, source state, or pixels. Closing one recovers it without touching others.
test("owned source windows isolate simultaneous builds and recover independently", { skip: !chrome, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "proto-browser-concurrency-"));
  const previousSession = process.env.PROTO_BROWSER_SESSION;
  const previousHome = process.env.PROTO_HOME;
  process.env.PROTO_HOME = root;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/login" }); res.end(); return; }
    res.setHeader("Content-Type", "text/html");
    const color = req.url.startsWith("/home") ? "rgb(220, 30, 30)" : "rgb(20, 50, 220)";
    res.end(`<html><body style="margin:0;background:${color};height:2000px"><h1>${req.url}</h1><button onclick="this.textContent='Clicked'">Open</button></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = join(root, "chrome");
  let child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const a = join(root, "home", "browser-session.json");
  const b = join(root, "playground", "browser-session.json");
  const c = join(root, "same-url", "browser-session.json");
  let browser;
  try {
    for (let i = 0; i < 100 && !existsSync(join(profile, "DevToolsActivePort")); i++) await delay(100);
    const port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    const urlA = `${origin}/home?view=one#start`;
    const [home, playground, same] = await Promise.all([
      acquireSourceSession(urlA, port, a), acquireSourceSession(`${origin}/playground`, port, b), acquireSourceSession(urlA, port, c),
    ]);
    assert.equal(new Set([home.session.targetId, playground.session.targetId, same.session.targetId]).size, 3);
    assert.equal(new Set([home.session.windowId, playground.session.windowId, same.session.windowId]).size, 3);
    assert.equal(home.tab.url, urlA);
    const repeated = await Promise.all([acquireSourceSession(urlA, port, a), acquireSourceSession(urlA, port, a)]);
    assert.ok(repeated.every(value => value.session.targetId === home.session.targetId));
    const source = await connect(home.tab.webSocketDebuggerUrl);
    const other = await connect(playground.tab.webSocketDebuggerUrl);
    const duplicate = await connect(same.tab.webSocketDebuggerUrl);
    await source.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 480, deviceScaleFactor: 1, mobile: false });
    await other.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 600, deviceScaleFactor: 1, mobile: false });
    await evaluate(source, "document.querySelector('button').click(); scrollTo(0, 120); true");
    assert.equal(await evaluate(other, "innerWidth"), 900);
    assert.equal(await evaluate(duplicate, "document.querySelector('button').textContent"), "Open");
    assert.equal(await evaluate(other, "scrollY"), 0);
    source.close(); other.close(); duplicate.close();

    process.env.PROTO_BROWSER_SESSION = a;
    const ownedA = await connect((await resolveSourceSession(urlA, port)).webSocketDebuggerUrl);
    await takeFrame(ownedA, "shared");
    const cacheA = framePaths("shared");
    ownedA.close();
    process.env.PROTO_BROWSER_SESSION = b;
    const ownedB = await connect((await resolveSourceSession(`${origin}/playground`, port)).webSocketDebuggerUrl);
    await takeFrame(ownedB, "shared");
    assert.notEqual(framePaths("shared").png, cacheA.png);
    assert.notDeepEqual(readFileSync(framePaths("shared").png), readFileSync(cacheA.png));
    ownedB.close();
    delete process.env.PROTO_BROWSER_SESSION;

    browser = await connect(home.session.browserId);
    const { targetId: userTab } = await browser.send("Target.createTarget", { url: `${origin}/user-tab` });
    await browser.send("Target.closeTarget", { targetId: home.session.targetId });
    const recovered = await acquireSourceSession(urlA, port, a);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.session.generation, 2);
    assert.notEqual(recovered.session.targetId, home.session.targetId);
    assert.equal((await acquireSourceSession(`${origin}/playground`, port, b)).session.targetId, playground.session.targetId);
    process.env.PROTO_BROWSER_SESSION = a;
    const recoveredPage = await connect(recovered.tab.webSocketDebuggerUrl);
    assert.equal(await frameCrop(recoveredPage, "shared", { x: 0, y: 0, width: 20, height: 20 }, join(root, "stale.png")), false);
    recoveredPage.close();
    delete process.env.PROTO_BROWSER_SESSION;
    await releaseSourceSession(a);
    const pages = await (await fetch(`http://localhost:${port}/json/list`)).json();
    assert.ok(pages.some(page => page.id === userTab));
    assert.ok(pages.some(page => page.id === playground.session.targetId));
    assert.ok(!pages.some(page => page.id === recovered.session.targetId));
    assert.equal(readSession(a).status, "released");

    const redirect = join(root, "redirect", "browser-session.json");
    await acquireSourceSession(`${origin}/redirect`, port, redirect);
    process.env.PROTO_BROWSER_SESSION = redirect;
    await assert.rejects(resolveSourceSession(`${origin}/redirect`, port), /expected.*redirect/);
    delete process.env.PROTO_BROWSER_SESSION;
    const stopped = once(child, "exit");
    await browser.send("Browser.close"); browser.close();
    await stopped;
    child = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      const current = await fetch(`http://localhost:${port}/json/version`).then(response => response.json()).catch(() => null);
      if (current && current.webSocketDebuggerUrl !== playground.session.browserId) break;
      await delay(100);
    }
    const restarted = await acquireSourceSession(`${origin}/playground`, port, b);
    assert.notEqual(restarted.session.browserId, playground.session.browserId);
    assert.equal(restarted.session.generation, 2);
    assert.equal(restarted.tab.url, `${origin}/playground`);
    browser = await connect(restarted.session.browserId);

  } finally {
    if (previousHome === undefined) delete process.env.PROTO_HOME;
    else process.env.PROTO_HOME = previousHome;
    if (previousSession === undefined) delete process.env.PROTO_BROWSER_SESSION;
    else process.env.PROTO_BROWSER_SESSION = previousSession;
    if (browser) { await browser.send("Browser.close").catch(() => {}); browser.close(); }
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await Promise.race([once(child, "exit"), delay(2000)]);
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
});
