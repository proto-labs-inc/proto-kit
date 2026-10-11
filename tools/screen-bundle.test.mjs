import { runInNewContext } from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  packScreen,
  unpackScreen,
  cloneScreen,
  sha256,
} from "./screen-bundle.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "proto-screen-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(join(source, "public"), { recursive: true });
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({
      name: "original",
      dependencies: {},
      scripts: { dev: "vite" },
    }),
  );
  writeFileSync(join(source, "package-lock.json"), "{}");
  writeFileSync(
    join(source, "index.html"),
    "<html><head></head><body>Example</body></html>",
  );
  writeFileSync(
    join(source, "public/prototype.json"),
    JSON.stringify({
      name: "Original",
      port: 5180,
      variantSets: [{ id: "old" }],
    }),
  );
  writeFileSync(
    join(source, "public/__proto-workspace.json"),
    JSON.stringify({ token: "original-secret" }),
  );
  writeFileSync(join(source, ".env.local"), "PASSWORD=secret");
  return { root, source };
}
test("packs only portable source and rejects symlinks and external dependencies", (t) => {
  const { root, source } = fixture(t);
  const bytes = packScreen(source);
  const bundle = JSON.parse(gunzipSync(bytes));
  assert.equal(
    bundle.files.some(
      (f) => f.path.includes(".env") || f.path.includes("__proto-workspace"),
    ),
    false,
  );
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ dependencies: { library: "file:../library" } }),
  );
  assert.throws(() => packScreen(source), /Vendor/);
  writeFileSync(join(source, "package.json"), "{}");
  symlinkSync(root, join(source, "outside"));
  assert.throws(() => packScreen(source), /symlink/);
});
test("checksum and traversal failures do not create a destination", (t) => {
  const { root, source } = fixture(t);
  const bytes = packScreen(source);
  const dest = join(root, "copy");
  assert.throws(() => unpackScreen(bytes, "0".repeat(64), dest), /checksum/);
  assert.equal(existsSync(dest), false);
  const bundle = JSON.parse(gunzipSync(bytes));
  bundle.files.push({ path: "../escape", data: "YQ==" });
  const malicious = gzipSync(JSON.stringify(bundle));
  assert.throws(
    () => unpackScreen(malicious, sha256(malicious), dest),
    /Unsafe/,
  );
  assert.equal(existsSync(join(root, "escape")), false);
  assert.equal(existsSync(dest), false);
});
test("fresh and cached copies have independent editable files and fresh identities; only exact retries resume", async (t) => {
  const { root, source } = fixture(t);
  const bytes = packScreen(source);
  const screen = {
    id: "screen-1",
    title: "Users",
    bundle_checksum: sha256(bytes),
    initial_state: { dialog: "invite" },
  };
  const one = {
    destination: join(root, "one"),
    slug: "one",
    codebase: "example",
    briefId: "brief-one",
    port: 5181,
  };
  const two = {
    destination: join(root, "two"),
    slug: "two",
    codebase: "example",
    briefId: "brief-two",
    port: 5182,
  };
  await cloneScreen(bytes, screen, one);
  await cloneScreen(Buffer.from(bytes), screen, two);
  const identity = (options) =>
    JSON.parse(
      readFileSync(join(options.destination, "public/__proto-workspace.json")),
    );
  assert.notEqual(identity(one).token, identity(two).token);
  assert.equal(identity(two).slug, "two");
  assert.match(
    JSON.parse(readFileSync(join(two.destination, "package.json"))).scripts.dev,
    /--port 5182/,
  );
  const original = readFileSync(join(two.destination, "index.html"), "utf8");
  assert.match(original, /"dialog":"invite"/);
    const boot = original.match(/<script>(.*?)<\/script>/)[1];
    let address;
    const location={search:"?__protoTheme=dark",pathname:"/",hash:""};
    runInNewContext(boot,{location,URLSearchParams,history:{replaceState(_state,_title,url){address=url;}}});
    assert.equal(address,"/?__protoTheme=dark&dialog=invite");
    address=undefined;location.search="?dialog=closed";
    runInNewContext(boot,{location,URLSearchParams,history:{replaceState(_state,_title,url){address=url;}}});
    assert.equal(address,undefined);
  writeFileSync(join(one.destination, "index.html"), "edited");
  assert.equal(
    readFileSync(join(two.destination, "index.html"), "utf8"),
    original,
  );
  assert.equal((await cloneScreen(bytes, screen, one)).resumed, true);
  await assert.rejects(
    cloneScreen(bytes, screen, { ...one, briefId: "different" }),
    /another request/,
  );
  assert.equal(
    readFileSync(join(one.destination, "index.html"), "utf8"),
    "edited",
  );
  assert.deepEqual(
    JSON.parse(readFileSync(join(two.destination, "public/prototype.json")))
      .variantSets,
    [],
  );
});
