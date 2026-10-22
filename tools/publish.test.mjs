import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withoutLegacySources } from "./snapshot.mjs";

const publish = fileURLToPath(new URL("./publish.mjs", import.meta.url));

/** A built prototype as the workspace template leaves it: its identity
 *  record and a captured Bootstrap glyphicons face, .eot included. */
function builtWorkspace() {
  const workspace = mkdtempSync(join(tmpdir(), "proto-publish-"));
  const dist = join(workspace, "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), '<!doctype html><link rel="stylesheet" href="./assets/index.css">');
  writeFileSync(join(dist, "prototype.json"), JSON.stringify({ name: "book-detail" }));
  writeFileSync(join(dist, "__proto-workspace.json"), JSON.stringify({ codebase: "cb", slug: "book-detail", token: "local" }));
  writeFileSync(join(dist, "assets", "index.css"), "@font-face{font-family:g;src:url(./glyph.woff2) format('woff2')}");
  writeFileSync(join(dist, "assets", "glyph.woff2"), "w");
  writeFileSync(join(dist, "assets", "glyph.eot"), "e");
  return workspace;
}

test("a build publishes without the workspace's identity record or .eot fonts", () => {
  const res = spawnSync(process.execPath, [publish, "--kind", "prototype", builtWorkspace(), "--codebase", "cb", "--slug", "book-detail", "--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /left out \(never published\): .*__proto-workspace\.json/);
  assert.match(res.stdout, /left out .*assets\/glyph\.eot/);
  assert.doesNotMatch(res.stdout, /would upload (__proto-workspace\.json|assets\/glyph\.eot)/);
  assert.match(res.stdout, /would upload assets\/glyph\.woff2 {2}\(font\/woff2/);
  assert.match(res.stdout, /would upload prototype\.json/);
});

test("a path the host refuses is named with the host's own rule", () => {
  const workspace = builtWorkspace();
  writeFileSync(join(workspace, "dist", "assets", "_private.js"), "");
  const res = spawnSync(process.execPath, [publish, "--kind", "prototype", workspace, "--codebase", "cb", "--slug", "book-detail", "--dry-run"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /assets\/_private\.js .*must start with a letter or digit/);
});

test("captured font faces drop Internet Explorer's .eot sources and keep the rest", () => {
  const bootstrap = `font-family:"Glyphicons Halflings";src:url(../fonts/g.eot);src:url(../fonts/g.eot?#iefix) format("embedded-opentype"),url(../fonts/g.woff2) format("woff2"),url(data:font/woff;base64,AA;BB,CC) format("woff")`;
  assert.equal(withoutLegacySources(bootstrap), `font-family:"Glyphicons Halflings"; src: url(../fonts/g.woff2) format("woff2"), url(data:font/woff;base64,AA;BB,CC) format("woff");`);
  assert.equal(withoutLegacySources("font-family:X;src:url(x.EOT)"), null);
  const modern = `font-family:Y;src:url(y.woff2) format("woff2");font-weight:400`;
  assert.equal(withoutLegacySources(modern), modern);
});

/** A fake Proto app: answers begin_publish with an upload for index.html
 *  only and calls everything else unchanged, and records every PUT. */
async function fakeApp() {
  const seen = { files: null, puts: [] };
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.method === "PUT") {
      seen.puts.push(req.url);
      res.writeHead(200).end();
      return;
    }
    const message = JSON.parse(body);
    let result = {};
    if (message.method === "tools/call") {
      const { name, arguments: args } = message.params;
      if (name === "begin_publish") {
        seen.files = args.files;
        result = { content: [{ text: JSON.stringify({
          buildId: "20261021T000000Z-abcd",
          pathnamePrefix: "cb/_library/20261021T000000Z-abcd/",
          uploads: [{ path: "index.html", contentType: "text/html", url: `${base}/put/index.html` }],
          copied: args.files.map((f) => f.path).filter((p) => p !== "index.html"),
        }) }] };
      } else if (name === "finish_publish") {
        result = { content: [{ text: JSON.stringify({ publishedUrl: `${base}/cb/_library/20261021T000000Z-abcd/` }) }] };
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` };
}

test("each file goes with its MD5, and only the uploads the app asks for are sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proto-publish-library-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ codebase: "cb" }));
  writeFileSync(join(dir, "big.js"), "unchanged");
  const app = await fakeApp();
  try {
    const child = spawn(process.execPath, [publish, "--kind", "library", "--codebase", "cb", "--dir", dir], {
      env: { ...process.env, PROTO_HOME: mkdtempSync(join(tmpdir(), "proto-home-")), PROTO_APP: app.url, PROTO_TOKEN: "t" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const code = await new Promise((done) => child.on("close", done));
    assert.equal(code, 0, out);
    const md5 = createHash("md5").update("unchanged").digest("hex");
    assert.deepEqual(app.seen.files.find((f) => f.path === "big.js"), { path: "big.js", contentType: "text/javascript", size: 9, md5 });
    assert.deepEqual(app.seen.puts, ["/put/index.html"]);
    assert.match(out, /1 to upload, 2 unchanged and copied/);
  } finally {
    app.server.close();
  }
});
