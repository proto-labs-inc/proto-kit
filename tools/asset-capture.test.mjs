import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { RESTART_CLEARS, restartCopy } from "./build-folder.mjs";
import { captureAssets } from "./read-page.mjs";
import { download, fetchFile, refusalOf, sniffBody } from "./snapshot.mjs";

const tools = dirname(fileURLToPath(import.meta.url));
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f30000000049454e44ae426082", "hex");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF rest of a jpeg")]);
const LOGIN = Buffer.from('<!DOCTYPE html>\n<html lang="en"><head><title>Login</title></head><body><form></form></body></html>');
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');

test("a body is judged by its bytes before its content type", () => {
  assert.deepEqual(sniffBody(PNG, "image/png"), { kind: "image", extension: "png" });
  assert.deepEqual(sniffBody(JPEG, ""), { kind: "image", extension: "jpg" });
  assert.deepEqual(sniffBody(SVG, "image/svg+xml"), { kind: "image", extension: "svg" });
  assert.equal(sniffBody(LOGIN, "image/png").kind, "html", "a login page labelled as an image is still a page");
  assert.equal(sniffBody(LOGIN, "").kind, "html");
  assert.equal(sniffBody(Buffer.from("hello there"), "text/plain").kind, "text");
  assert.equal(sniffBody(Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0, 0x80, 0x90]), "font/woff2").kind, "other");
});

test("an image name never gets a page or text; a font never gets a page", () => {
  assert.equal(refusalOf(PNG, "image/png", { image: true }), null);
  assert.match(refusalOf(LOGIN, "text/html", { image: true }), /web page \(HTML\).*sign-in/);
  assert.match(refusalOf(Buffer.from("plain words"), "text/plain", { image: true }), /text, not an image/);
  assert.equal(refusalOf(Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]), "font/woff2", { image: false }), null);
  assert.match(refusalOf(LOGIN, "", { image: false }), /web page/);
  assert.match(refusalOf(Buffer.alloc(0), "", { image: true }), /nothing/);
});

/** A tiny product: /cover needs the session cookie and otherwise redirects to /login, like Calibre-Web. */
async function product() {
  const server = createServer((req, res) => {
    const signedIn = (req.headers.cookie ?? "").includes("session=ok");
    if (req.url.startsWith("/cover")) {
      if (!signedIn) return res.writeHead(302, { location: `/login?next=${encodeURIComponent(req.url)}` }).end();
      return res.writeHead(200, { "content-type": "image/jpeg" }).end(JPEG);
    }
    if (req.url.startsWith("/login")) return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(LOGIN);
    if (req.url === "/lying.png") return res.writeHead(200, { "content-type": "image/png" }).end(LOGIN);
    if (req.url === "/real.png") return res.writeHead(200, { "content-type": "image/png" }).end(PNG);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test("a fetch without the session refuses the sign-in redirect instead of saving it", async () => {
  const site = await product();
  const dir = mkdtempSync(join(tmpdir(), "assets-"));
  try {
    await assert.rejects(fetchFile(`${site.base}/cover/2/og?c=1`, { image: true }), (error) => error.code === "NOT_THE_FILE" && /redirected \(302/.test(error.message));
    await assert.rejects(download(`${site.base}/lying.png`, join(dir, "image1.png")), (error) => error.code === "NOT_THE_FILE" && /web page/.test(error.message));
    assert.equal(existsSync(join(dir, "image1.png")), false, "nothing is written under the image name");
    const signed = await fetchFile(`${site.base}/cover/2/og?c=1`, { image: true, headers: { cookie: "session=ok" } });
    assert.equal(signed.extension, "jpg");
    await download(`${site.base}/real.png`, join(dir, "real.png"));
    assert.deepEqual(readFileSync(join(dir, "real.png")), PNG);
  } finally {
    site.close();
  }
});

/**
 * A stand-in for the live tab over CDP: the cache answers nothing (the
 * Page domain was not enabled before the load), the page's own fetch
 * carries the session or not, and the browser's cookies are given.
 */
function fakeTab(base, { pageSignedIn, cookies }) {
  const held = new Map();
  return {
    on: () => () => {},
    async send(method, params = {}) {
      if (method === "Page.getResourceTree") return { frameTree: { frame: { id: "f1" }, resources: [] } };
      if (method === "Page.getResourceContent") throw new Error("No resource with given URL found");
      if (method === "Network.getCookies") return { cookies };
      if (method === "Runtime.evaluate") return { result: { value: await this.evaluate(params.expression) } };
      return {};
    },
    async evaluate(expression) {
      const fetchCall = /fetch\(("[^"]+")/.exec(expression);
      const key = /window\[("__protoAsset[^"]+")\]/.exec(expression)?.[1];
      if (fetchCall) {
        const res = await fetch(JSON.parse(fetchCall[1]), { headers: pageSignedIn ? { cookie: "session=ok" } : {} });
        const bytes = Buffer.from(await res.arrayBuffer());
        held.set(key, bytes.toString("base64"));
        return { ok: res.ok, status: res.status, type: res.headers.get("content-type") ?? "", url: res.url, length: held.get(key).length };
      }
      const slice = /\.slice\((\d+), (\d+)\)/.exec(expression);
      if (slice) return held.get(key).slice(Number(slice[1]), Number(slice[2]));
      if (expression.startsWith("delete")) return held.delete(key);
      return null;
    },
  };
}

test("captureAssets saves an image behind a sign-in with the page's session, named by what it is", async () => {
  const site = await product();
  const dir = mkdtempSync(join(tmpdir(), "assets-"));
  const url = `${site.base}/cover/2/og?c=1791181629`;
  try {
    const { assets } = await captureAssets(fakeTab(site.base, { pageSignedIn: true, cookies: [] }), { images: [url], page: { url: `${site.base}/book/2` } }, dir);
    assert.ok(assets[url].endsWith("og.jpg"), assets[url]);
    assert.deepEqual(readFileSync(assets[url]), JPEG);
  } finally {
    site.close();
  }
});

test("captureAssets falls back to the browser's cookies, and never saves a login page as an image", async () => {
  const site = await product();
  const url = `${site.base}/cover/2/og?c=1`;
  try {
    // The page's fetch is refused (it lands on the login page); the cookie fetch gets the image.
    const viaCookies = mkdtempSync(join(tmpdir(), "assets-"));
    const first = await captureAssets(fakeTab(site.base, { pageSignedIn: false, cookies: [{ name: "session", value: "ok" }] }), { images: [url], page: { url: site.base } }, viaCookies);
    assert.deepEqual(readFileSync(first.assets[url]), JPEG);
    // No session anywhere: nothing is saved, rather than the login page under an image name.
    const signedOut = mkdtempSync(join(tmpdir(), "assets-"));
    const second = await captureAssets(fakeTab(site.base, { pageSignedIn: false, cookies: [] }), { images: [url], page: { url: site.base } }, signedOut);
    assert.deepEqual(second.assets, {});
    assert.deepEqual(readdirSync(signedOut), []);
  } finally {
    site.close();
  }
});

test("--again clears the read, the curation and the copy, and keeps the title and pass numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-"));
  for (const name of [...RESTART_CLEARS, "steps.json", "workspace.json", "passes.json", "events.jsonl"]) {
    if (name === "assets" || name === "before") mkdirSync(join(dir, name, "x"), { recursive: true });
    else writeFileSync(join(dir, name), "{}");
  }
  const steps = restartCopy(dir, { title: "t", gate: { outcome: "build" }, gateAt: "t" });
  assert.deepEqual(steps, { title: "t" });
  assert.deepEqual(readdirSync(dir).sort(), ["events.jsonl", "passes.json", "steps.json", "workspace.json"]);
});

test("creation refuses live recapture flags without deleting old checkpoints", () => {
  const home = mkdtempSync(join(tmpdir(), "home-"));
  const build = join(home, ".proto", "cb1", "run", "builds", "b1");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "tree.json"), JSON.stringify({ url: "http://localhost:8083/book/2", nodes: [] }));
  for (const name of ["read.json", "curation.json", "parts.json", "copy-gate.json"]) writeFileSync(join(build, name), "{}");
  const run = spawnSync(process.execPath, [join(tools, "proto-build.mjs"), "prepare", "b1", "--codebase", "cb1", "--again", "--no-send"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.notEqual(run.status, 0);
  assert.match(JSON.parse(run.stdout).diagnostics.join(" "), /Unknown or valueless option --again/);
  for (const name of ["tree.json", "read.json", "curation.json", "parts.json", "copy-gate.json"]) assert.equal(existsSync(join(build, name)), true, name);
});
