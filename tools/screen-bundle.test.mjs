import { randomBytes } from "node:crypto";
import { isBase64, SCREEN_ARTIFACT_LIMIT } from "./screen-archive.mjs";
import { widthsFor } from "./screen-verification.mjs";
import { packScreenBuild, unpackScreenBuild } from "./screen-build.mjs";
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
  mkdirSync(join(source, "dist"));
  writeFileSync(
    join(source, "dist/index.html"),
    readFileSync(join(source, "index.html")),
  );
  writeFileSync(
    join(source, "dist/prototype.json"),
    readFileSync(join(source, "public/prototype.json")),
  );
  const buildBytes = packScreenBuild(
    join(source, "dist"),
    screen.bundle_checksum,
  );
  screen.metadata = {
    preparedBuild: {
      checksum: sha256(buildBytes),
      sourceChecksum: screen.bundle_checksum,
    },
  };
  screen.index_id = "b7247cd5-15d8-47a0-a508-dd0e259108a6";
  screen.source_url = "https://source.invalid/users";
  screen.metadata.verification = {
    version: 3, sourceChecksum: screen.bundle_checksum, buildChecksum: screen.metadata.preparedBuild.checksum,
    inventory: { sourceUrl: screen.source_url, capturedAt: new Date().toISOString(), controls: [], states: ["default"], breakpoints: [] },
    scenarios: widthsFor({ breakpoints: [] }).flatMap(width => ["visual","responsive","state","isolation"].map(category => ({
      id: `${category}-${width}`, category, target: "default", viewport: {width,height:900}, ...(category === "responsive" ? { resizedFrom: width < 1024 ? 1440 : 390 } : {}), outcome: "passed", problems: [],
      evidence: [`screen-indexes/${screen.index_id}/${"a".repeat(64)}.png`],
    }))),
  };
  const one = {
    buildBytes,
    destination: join(root, "one"),
    slug: "one",
    codebase: "example",
    briefId: "brief-one",
    port: 5181,
  };
  const two = {
    buildBytes,
    destination: join(root, "two"),
    slug: "two",
    codebase: "example",
    briefId: "brief-two",
    port: 5182,
  };
  await cloneScreen(bytes, screen, one);
  await cloneScreen(Buffer.from(bytes), screen, two);
  assert.equal(existsSync(join(one.destination, "node_modules")), false);
  assert.equal(
    readFileSync(join(one.destination, "dist/prototype.json"), "utf8"),
    readFileSync(join(one.destination, "public/prototype.json"), "utf8"),
  );
  assert.equal(
    readFileSync(join(one.destination, "dist/__proto-workspace.json"), "utf8"),
    readFileSync(
      join(one.destination, "public/__proto-workspace.json"),
      "utf8",
    ),
  );
  assert.equal(
    readFileSync(join(one.destination, "dist/index.html"), "utf8"),
    readFileSync(join(one.destination, "index.html"), "utf8"),
  );
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
  const location = { search: "?__protoTheme=dark", pathname: "/", hash: "" };
  runInNewContext(boot, {
    location,
    URLSearchParams,
    history: {
      replaceState(_state, _title, url) {
        address = url;
      },
    },
  });
  assert.equal(address, "/?__protoTheme=dark&dialog=invite");
  address = undefined;
  location.search = "?dialog=closed";
  runInNewContext(boot, {
    location,
    URLSearchParams,
    history: {
      replaceState(_state, _title, url) {
        address = url;
      },
    },
  });
  assert.equal(address, undefined);
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

test("prepared builds reject corrupt bytes, another source, unsafe paths, and leaking identity", (t) => {
  const { root, source } = fixture(t);
  const dist = join(source, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html><head></head></html>");
  writeFileSync(join(dist, "prototype.json"), "{}");
  writeFileSync(join(dist, "__proto-workspace.json"), "secret");
  writeFileSync(join(dist, ".env"), "secret");
  writeFileSync(join(dist, "app.js.map"), "source paths");
  const sourceChecksum = sha256(packScreen(source));
  const bytes = packScreenBuild(dist, sourceChecksum);
  const archive = JSON.parse(gunzipSync(bytes));
  assert.equal(archive.files.length, 2);
  const dest = join(root, "extracted");
  assert.throws(
    () => unpackScreenBuild(bytes, "0".repeat(64), sourceChecksum, dest),
    /checksum/,
  );
  assert.throws(
    () => unpackScreenBuild(bytes, sha256(bytes), "0".repeat(64), dest),
    /source/,
  );
  for (const path of [
    "../escape",
    "/escape",
    "a/../../escape",
    "C:/escape",
    "a\\escape",
    "__proto-workspace.json",
  ]) {
    const malicious = gzipSync(
      JSON.stringify({
        ...archive,
        files: [...archive.files, { path, data: "YQ==" }],
      }),
    );
    assert.throws(
      () =>
        unpackScreenBuild(malicious, sha256(malicious), sourceChecksum, dest),
      /Unsafe/,
    );
    assert.equal(existsSync(dest), false);
  }
  unpackScreenBuild(bytes, sha256(bytes), sourceChecksum, dest);
  assert.equal(readFileSync(join(dest, "prototype.json"), "utf8"), "{}");
});


test("large original media round-trips in source and compiled archives", (t) => {
  const { root, source } = fixture(t);
  const media = randomBytes(33 * 1024 * 1024);
  writeFileSync(join(source, "public/video.mp4"), media);
  const bytes = packScreen(source);
  assert.ok(bytes.length > 32 * 1024 * 1024);
  assert.ok(bytes.length < SCREEN_ARTIFACT_LIMIT);
  const copiedSource = join(root, "large-source");
  unpackScreen(bytes, sha256(bytes), copiedSource);
  assert.deepEqual(readFileSync(join(copiedSource, "public/video.mp4")), media);
  const dist = join(source, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<html></html>");
  writeFileSync(join(dist, "prototype.json"), "{}");
  writeFileSync(join(dist, "video.mp4"), media);
  const built = packScreenBuild(dist, sha256(bytes));
  assert.ok(built.length > 32 * 1024 * 1024);
  const copiedBuild = join(root, "large-build");
  unpackScreenBuild(built, sha256(built), sha256(bytes), copiedBuild);
  assert.deepEqual(readFileSync(join(copiedBuild, "video.mp4")), media);
});

test("base64 validator rejects bad lengths, misplaced padding and alphabet", () => {
  for (const value of ["", "YQ==", "YWI=", "YWJj", "YWJjZA=="]) assert.equal(isBase64(value), true);
  for (const value of [null, "A", "A===", "A=AA", "AA?=", "AAAA\n", "===="]) assert.equal(isBase64(value), false);
});
