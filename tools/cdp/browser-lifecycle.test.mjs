import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./cdp.mjs";
import { ephemeralPort } from "../ports.mjs";
const exec = promisify(execFile);
const enabled = process.platform === "darwin" && Boolean(process.env.PROTO_TEST_CHROME);

test("cold startup is shared; each build owns and releases its renderer", { skip: !enabled, timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "proto-browser-lifecycle-"));
  const port = await ephemeralPort();
  const profile = join(root, "source-chrome");
  const env = { ...process.env, PROTO_HOME: root };
  delete env.PROTO_BROWSER_SESSION;
  const run = (name, args, extra = {}) => exec(process.execPath, [fileURLToPath(new URL(name, import.meta.url)), ...args], { env: { ...env, ...extra }, timeout: 25_000 });
  let browser;
  const sessions = [join(root, "a/browser-session.json"), join(root, "b/browser-session.json")];
  try {
    const starts = await Promise.all([run("chrome.mjs", [String(port), profile]), run("chrome.mjs", [String(port), profile])]);
    assert.ok(starts.every(result => result.stdout.includes(String(port))));
    const version = await (await fetch(`http://localhost:${port}/json/version`)).json();
    browser = await connect(version.webSocketDebuggerUrl);
    // An http page with no network dependency is supplied by Chrome's own debug endpoint.
    const url = `http://localhost:${port}/json/version`;
    await Promise.all(sessions.map(path => run("product-page.mjs", [url, "--port", String(port), "--browser-session", path])));
    await Promise.all(sessions.map(path => run("headless.mjs", ["start", "--browser-session", path])));
    const renderers = sessions.map(path => JSON.parse(readFileSync(join(path, "../chrome-headless/renderer.json"), "utf8")));
    assert.notEqual(renderers[0].port, renderers[1].port);
    assert.notEqual(renderers[0].browserId, renderers[1].browserId);
    await run("headless.mjs", ["stop", "--browser-session", sessions[0]]);
    const surviving = await (await fetch(`http://localhost:${renderers[1].port}/json/version`)).json();
    assert.equal(surviving.webSocketDebuggerUrl, renderers[1].browserId);
    await Promise.all(sessions.map(path => run("product-page.mjs", ["release", "--browser-session", path])));
    const reservations = JSON.parse(readFileSync(join(root, "port-reservations.json"), "utf8"));
    assert.deepEqual(reservations, {});
  } finally {
    for (const path of sessions) await run("product-page.mjs", ["release", "--browser-session", path]).catch(() => {});
    if (browser) { await browser.send("Browser.close").catch(() => {}); browser.close(); }
    rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
  }
});
