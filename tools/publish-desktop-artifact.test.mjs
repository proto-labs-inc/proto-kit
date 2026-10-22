import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { prepareRelease } from "./publish-release.mjs";
import { artifactPrefix, buildKitArtifact, canonicalArtifact, uploadKitArtifact } from "./publish-desktop-artifact.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signingKey = privateKey.export({ format: "pem", type: "pkcs8" });

function fixture(t, channel = "main") {
  const cwd = mkdtempSync(join(tmpdir(), "proto-desktop-release-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.email", "test@example.test"); git("config", "user.name", "Test");
  for (const path of [".codex-plugin", ".cursor-plugin", "skills", "tools", "template"]) mkdirSync(join(cwd, path));
  for (const path of [".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"]) writeFileSync(join(cwd, path), JSON.stringify({ name: "proto", version: "0.1.0+codex.20261001000000" }));
  for (const path of ["skills/task.md", "tools/test.mjs", "template/index.html"]) writeFileSync(join(cwd, path), "test fixture");
  git("add", "."); git("commit", "-qm", "source");
  const source = git("rev-parse", "HEAD");
  const release = prepareRelease({ cwd, source, runId: "1", channel, now: new Date("2026-10-22T00:00:00Z") });
  const args = { cwd, commit: release.commit, outputDirectory: join(cwd, "artifacts"), signingKey, keyId: "test", baseURL: "https://updates.example.test/", channel };
  return { cwd, source, release, args, git };
}

test("generated desktop archive is deterministic and signed over exact release identity", t => {
  const { cwd, args, release, source, git } = fixture(t);
  const first = buildKitArtifact(args);
  const second = buildKitArtifact({ ...args, outputDirectory: join(cwd, "retry") });
  assert.deepEqual(first.descriptor, second.descriptor);
  assert.ok(readFileSync(first.archivePath).equals(readFileSync(second.archivePath)));
  assert.equal(first.descriptor.version, release.version);
  assert.equal(first.descriptor.releaseCommit, release.commit);
  assert.equal(first.descriptor.sourceCommit, source);
  assert.equal(first.descriptor.sha256, createHash("sha256").update(readFileSync(first.archivePath)).digest("hex"));
  assert.ok(verify(null, Buffer.from(canonicalArtifact(first.descriptor)), publicKey, Buffer.from(first.descriptor.signature, "base64")));
  assert.equal(first.descriptor.url, `https://updates.example.test/kit/main/${encodeURIComponent(release.version)}/proto-kit.tar.gz`);
  const tarPath = join(cwd, "archive.tar"); writeFileSync(tarPath, gunzipSync(readFileSync(first.archivePath)));
  const paths = execFileSync("tar", ["-tf", tarPath], { encoding: "utf8" });
  assert.match(paths, /\.proto-release.json/);
  assert.match(paths, /skills\/task.md/);
  assert.equal(git("status", "--porcelain", "--untracked-files=no"), "");
});

test("preview releases carry their own branch and safe URL-encoded channel", t => {
  const { args, release } = fixture(t, "feature/update");
  const artifact = buildKitArtifact(args);
  assert.equal(artifact.descriptor.channel, "feature/update");
  assert.equal(artifactPrefix("feature/update", release.version), `kit/feature/update/${release.version}`);
  assert.match(artifact.descriptor.url, /kit\/feature%2Fupdate\//);
  assert.throws(() => buildKitArtifact({ ...args, channel: "main" }), /provenance/);
  assert.throws(() => artifactPrefix("../oops", release.version), /Invalid/);
});

test("missing or invalid signing inputs fail before any publication", t => {
  const { args } = fixture(t);
  for (const changes of [{ signingKey: undefined }, { keyId: "" }, { commit: "bad" }, { baseURL: "http://updates.test" }, { minimumBridgeVersion: 0 }]) assert.throws(() => buildKitArtifact({ ...args, ...changes }));
});

test("upload publishes descriptor last, confirms retries, and refuses changing an immutable object", async t => {
  const { args } = fixture(t);
  const artifact = buildKitArtifact(args);
  const objects = new Map();
  const writes = [];
  const run = async (command, argv) => {
    assert.equal(command, "aws");
    assert.equal(argv[0], "s3api");
    const key = argv[argv.indexOf("--key") + 1];
    if (argv[1] === "get-object") {
      if (!objects.has(key)) throw Object.assign(new Error("missing"), { stderr: "NoSuchKey" });
      writeFileSync(argv.at(-1), objects.get(key));
      return "";
    }
    assert.equal(argv[1], "put-object");
    assert.equal(argv[argv.indexOf("--if-none-match") + 1], "*");
    assert.equal(argv[argv.indexOf("--content-type") + 1], key.endsWith("json") ? "application/json" : "application/gzip");
    assert.equal(argv[argv.indexOf("--cache-control") + 1], "public,max-age=31536000,immutable");
    assert.equal(objects.has(key), false);
    objects.set(key, readFileSync(argv[argv.indexOf("--body") + 1])); writes.push(key);
    return "";
  };
  const config = { bucket: "updates", endpoint: "https://account.r2.cloudflarestorage.com", run };
  await uploadKitArtifact(artifact, config);
  assert.equal(writes.length, 2);
  assert.ok(writes[0].endsWith("proto-kit.tar.gz"));
  assert.ok(writes[1].endsWith("kit-artifact.json"));
  await uploadKitArtifact(artifact, config);
  assert.equal(writes.length, 2);
  objects.set(writes[0], Buffer.from("different archive"));
  await assert.rejects(uploadKitArtifact(artifact, config), /different bytes/);
  assert.equal(writes.length, 2);
});

test("a partially completed upload can be retried without replacing the archive", async t => {
  const { args } = fixture(t);
  const artifact = buildKitArtifact(args);
  const stored = readFileSync(artifact.archivePath);
  const writes = [];
  await uploadKitArtifact(artifact, { bucket: "updates", endpoint: "https://r2.example.test", run: async (_command, argv) => {
    if (argv[1] === "get-object") {
      if (argv[argv.indexOf("--key") + 1].endsWith("kit-artifact.json")) throw Object.assign(new Error("missing"), { stderr: "404" });
      writeFileSync(argv.at(-1), stored); return;
    }
    assert.equal(argv[1], "put-object");
    assert.equal(argv[argv.indexOf("--if-none-match") + 1], "*");
    writes.push(argv[argv.indexOf("--key") + 1]);
  } });
  assert.equal(writes.length, 1);
  assert.ok(writes[0].endsWith("kit-artifact.json"));
});

test("storage authentication or service failure is never treated as a missing object", async t => {
  const { args } = fixture(t);
  let calls = 0;
  await assert.rejects(uploadKitArtifact(buildKitArtifact(args), { bucket: "updates", endpoint: "https://r2.example.test", run: () => {
    calls++; throw Object.assign(new Error("service refused"), { stderr: "AccessDenied" });
  } }), /service refused/);
  assert.equal(calls, 1);
});

for (const identical of [true, false]) {
  test(`a concurrent create is ${identical ? "confirmed without overwriting" : "rejected when its bytes differ"}`, async t => {
    const artifact = buildKitArtifact(fixture(t).args);
    const objects = new Map();
    let puts = 0;
    const config = { bucket: "updates", endpoint: "https://r2.example.test", run: async (_command, argv) => {
      const key = argv[argv.indexOf("--key") + 1];
      if (argv[1] === "get-object") {
        if (!objects.has(key)) throw Object.assign(new Error("missing"), { stderr: "NoSuchKey" });
        writeFileSync(argv.at(-1), objects.get(key));
        return;
      }
      assert.equal(argv[1], "put-object");
      assert.equal(argv[argv.indexOf("--if-none-match") + 1], "*");
      puts++;
      // Another writer wins after GET reported missing, before our conditional PUT.
      objects.set(key, identical ? readFileSync(argv[argv.indexOf("--body") + 1]) : Buffer.from("other writer"));
      throw Object.assign(new Error("concurrent create"), { stderr: "An error occurred (PreconditionFailed) when calling the PutObject operation: 412" });
    } };
    if (identical) {
      await uploadKitArtifact(artifact, config);
      assert.equal(puts, 2);
      await uploadKitArtifact(artifact, config);
      assert.equal(puts, 2, "retry must only read and confirm existing objects");
    } else {
      await assert.rejects(uploadKitArtifact(artifact, config), /different bytes/);
      assert.equal(puts, 1, "a mismatched archive must stop descriptor publication");
      assert.equal(objects.get(`${artifact.prefix}/proto-kit.tar.gz`).toString(), "other writer");
    }
  });
}

test("a conditional conflict with no committed object retries with the condition intact", async t => {
  const artifact = buildKitArtifact(fixture(t).args);
  const attempts = new Map();
  await uploadKitArtifact(artifact, { bucket: "updates", endpoint: "https://r2.example.test", run: async (_command, argv) => {
    if (argv[1] === "get-object") throw Object.assign(new Error("missing"), { stderr: "404" });
    assert.equal(argv[1], "put-object");
    assert.equal(argv[argv.indexOf("--if-none-match") + 1], "*");
    const key = argv[argv.indexOf("--key") + 1];
    attempts.set(key, (attempts.get(key) ?? 0) + 1);
    if (attempts.get(key) === 1) throw Object.assign(new Error("conflict"), { stderr: "ConditionalRequestConflict: 409" });
  } });
  assert.deepEqual([...attempts.values()], [2, 2]);
});

test("repeated conditional conflicts are bounded and never publish the descriptor", async t => {
  const artifact = buildKitArtifact(fixture(t).args);
  let puts = 0;
  await assert.rejects(uploadKitArtifact(artifact, { bucket: "updates", endpoint: "https://r2.example.test", run: async (_command, argv) => {
    assert.ok(argv[argv.indexOf("--key") + 1].endsWith("proto-kit.tar.gz"));
    if (argv[1] === "get-object") throw Object.assign(new Error("missing"), { stderr: "NoSuchKey" });
    assert.equal(argv[argv.indexOf("--if-none-match") + 1], "*");
    puts++;
    throw Object.assign(new Error("conflict"), { stderr: "ConditionalRequestConflict: 409" });
  } }), /conflict/);
  assert.equal(puts, 3);
});
