import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { acquireSourceSession, releaseSourceSession } from "./cdp/source-session.mjs";
import { captureReferences } from "./cdp/reference.mjs";
import { decodePng } from "./cdp/png.mjs";
import { diffPngs } from "./cdp/diff.mjs";
import { pngSize, referenceScale } from "./cdp/render-profile.mjs";
import { runScenario, serveBuild } from "./verify-screen.mjs";
import { ephemeralPort } from "./ports.mjs";

test("reference scale is read from the PNG, never assumed", () => {
  assert.equal(referenceScale([800, 600], { width: 800, height: 600 }), 1);
  assert.equal(referenceScale([1600, 1200], { width: 800, height: 600 }), 2);
  assert.equal(referenceScale([785, 600], { width: 800, height: 600 }), null);
  assert.throws(() => pngSize(Buffer.from("not a png at all, really not")), /PNG/);
});

// A page whose layout depends on its width, with a loud custom scrollbar.
const PAGE = `<!doctype html><html><head><link rel="icon" href="data:,"><style>
  ::-webkit-scrollbar{width:15px;height:15px}
  ::-webkit-scrollbar-track{background:#00ff00}
  ::-webkit-scrollbar-thumb{background:#ff00ff}
  body{margin:0;font:16px/1.4 system-ui,sans-serif;background:#fff}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;padding:8px}
  .card{background:#246;color:#fff;height:120px;padding:8px}
  .rule{height:4px;background:#c00;width:100%}
</style></head><body><div class="rule"></div><div class="grid">${Array.from({ length: 40 }, (_, i) => `<div class="card">Card ${i} with some wrapping text</div>`).join("")}</div>
<script>parent.postMessage({type:'hello'},'*')</script></body></html>`;

/** Pixels in the right-most 15 CSS px that are the scrollbar's green or magenta. */
function scrollbarPixels(png, scale) {
  const image = decodePng(png);
  let count = 0;
  for (let y = 0; y < image.height; y++)
    for (let x = image.width - 15 * scale; x < image.width; x++) {
      const i = (y * image.width + x) * 4;
      const [r, g, b] = image.data.subarray(i, i + 3);
      if ((r < 40 && g > 215 && b < 40) || (r > 215 && g < 40 && b > 215)) count++;
    }
  return count;
}

test("on a 2x display with a custom scrollbar, the reference and the copy draw alike", { skip: process.env.PROTO_BROWSER_TEST !== "1" || process.platform !== "darwin", timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "proto-render-parity-"));
  const previousHome = process.env.PROTO_HOME;
  const previousSession = process.env.PROTO_BROWSER_SESSION;
  process.env.PROTO_HOME = root;
  const session = join(root, "run", "browser-session.json");
  process.env.PROTO_BROWSER_SESSION = session;

  // The live product, on its own origin.
  const source = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(PAGE); });
  await new Promise((done) => source.listen(0, "127.0.0.1", done));
  const sourceUrl = `http://127.0.0.1:${source.address().port}/`;
  // The copy: the same markup, served as a build.
  const build = join(root, "dist");
  rmSync(build, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "index.html"), PAGE);
  writeFileSync(join(build, "prototype.json"), "{}");
  const served = await serveBuild(build);

  // The signed-in source browser on a Retina display: 2x, scrollbars drawn.
  const port = await ephemeralPort();
  const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--mute-audio", `--remote-debugging-port=${port}`, `--user-data-dir=${join(root, "source-chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--force-color-profile=srgb", "--force-device-scale-factor=2", "about:blank",
  ], { stdio: "ignore" });
  t.after(async () => {
    await releaseSourceSession(session).catch(() => {});
    try {
      const version = await (await fetch(`http://localhost:${port}/json/version`)).json();
      const browser = await connect(version.webSocketDebuggerUrl);
      await browser.send("Browser.close").catch(() => {});
      browser.close();
    } catch {}
    chrome.kill();
    await served.close();
    source.close();
    if (previousHome === undefined) delete process.env.PROTO_HOME; else process.env.PROTO_HOME = previousHome;
    if (previousSession === undefined) delete process.env.PROTO_BROWSER_SESSION; else process.env.PROTO_BROWSER_SESSION = previousSession;
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://localhost:${port}/json/version`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }

  const { tab, session: record } = await acquireSourceSession(sourceUrl, port, session);
  assert.equal(record.display.dpr, 2, "the source window is on a 2x display");
  const viewport = { width: 800, height: 600 };
  const page = await connect(tab.webSocketDebuggerUrl);
  let raw;
  let references;
  try {
    // What an agent's own capture of the window gave: 2x, with the scrollbar.
    await page.send("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 0, mobile: false });
    raw = Buffer.from((await page.send("Page.captureScreenshot", { format: "png" })).data, "base64");
    assert.equal(await evaluate(page, "document.documentElement.clientWidth"), 785, "the scrollbar takes layout width in the source window");
    await page.send("Emulation.clearDeviceMetricsOverride");
    references = await captureReferences(page, { outDir: join(root, "references"), widths: [viewport.width, 500], height: viewport.height });
    // The source window is left as it was found.
    assert.equal(await evaluate(page, "devicePixelRatio"), 2);
    assert.notEqual(await evaluate(page, "document.documentElement.clientWidth"), 800);
  } finally {
    page.close();
  }
  assert.deepEqual(pngSize(raw), [1600, 1200]);
  assert.ok(scrollbarPixels(raw, 2) > 1000, "the uncorrected capture paints the custom scrollbar");

  for (const width of [viewport.width, 500]) {
    const reference = readFileSync(references[width]);
    assert.deepEqual(pngSize(reference), [width, viewport.height], "references are 1x at the CSS viewport");
    assert.equal(scrollbarPixels(reference, 1), 0, "references paint no scrollbar, custom ones included");
    for (const category of ["visual", "responsive"]) {
      const out = join(root, `copy-${category}-${width}.png`);
      const capture = {};
      const problems = await runScenario(served.url, { category, path: "/", assertion: "true" }, out, { width, height: viewport.height }, references[width], capture);
      assert.deepEqual(problems, [], `${category} at ${width}: the copy matches its reference`);
      assert.equal(capture.render.dpr, 1);
      assert.deepEqual(pngSize(readFileSync(out)), [width, viewport.height]);
      assert.equal(scrollbarPixels(readFileSync(out), 1), 0, "the copy paints no scrollbar either");
      assert.ok(parseFloat(diffPngs(references[width], out, { dpr: 1 }).pct) < 0.05, "pixel for pixel, not just inside the 1% gate");
    }
  }
});
