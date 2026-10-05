import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
