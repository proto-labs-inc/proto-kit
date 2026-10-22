#!/usr/bin/env node
/** Build and publish the immutable desktop kit only after the Git release exists. */
import { createHash, createPrivateKey, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { validChannel } from "./publish-release.mjs";

const MAX_ARCHIVE = 128 * 1024 * 1024;
const MAX_EXPANDED = 512 * 1024 * 1024;
const VERSION = /^0\.1\.0\+codex\.\d{14}$/;
const SHA = /^[0-9a-f]{40}$/;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");

export function canonicalArtifact(descriptor) {
  const { signature: _signature, ...body } = descriptor;
  return JSON.stringify(Object.fromEntries(Object.keys(body).sort().map(key => [key, body[key]])));
}

export function artifactPrefix(channel, version) {
  if (!validChannel(channel) || !VERSION.test(version)) throw new Error("Invalid desktop artifact channel or version");
  return `kit/${channel}/${version}`;
}

export function buildKitArtifact({ cwd, commit, outputDirectory, signingKey, keyId, baseURL, channel = "main", minimumBridgeVersion = 1 }) {
  if (!SHA.test(commit ?? "") || !validChannel(channel) || !keyId || typeof signingKey !== "string") throw new Error("Missing desktop artifact signing configuration");
  const base = new URL(baseURL);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Artifact base URL requires HTTPS without credentials, query or fragment");
  if (!Number.isSafeInteger(minimumBridgeVersion) || minimumBridgeVersion < 1) throw new Error("Invalid minimum desktop bridge version");
  const privateKey = createPrivateKey(signingKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Desktop artifacts require an Ed25519 signing key");
  const git = args => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const manifest = JSON.parse(git(["show", `${commit}:.codex-plugin/plugin.json`]));
  const provenance = JSON.parse(git(["show", `${commit}:.proto-release.json`]));
  if (manifest.name !== "proto" || !VERSION.test(manifest.version) || provenance.version !== manifest.version
    || !SHA.test(provenance.sourceCommit ?? "") || (provenance.channel ?? "main") !== channel) throw new Error("Release provenance does not match the artifact channel and version");
  const tree = git(["ls-tree", "-r", commit]);
  if (/^(?:120000|160000) /m.test(tree)) throw new Error("Desktop kit archives cannot contain symlinks or submodules");
  // git archive uses the commit's timestamp and tracked bytes, so retries produce
  // the same archive even on another runner. Node gzip emits a zero mtime.
  const plain = execFileSync("git", ["archive", "--format=tar", commit], { cwd, maxBuffer: MAX_EXPANDED, stdio: ["ignore", "pipe", "pipe"] });
  const bytes = gzipSync(plain, { level: 9 });
  if (bytes.length > MAX_ARCHIVE) throw new Error("Desktop kit archive is too large");
  const prefix = artifactPrefix(channel, manifest.version);
  const url = new URL(`kit/${encodeURIComponent(channel)}/${encodeURIComponent(manifest.version)}/proto-kit.tar.gz`, base.href.replace(/\/?$/, "/")).href;
  const body = { schemaVersion: 1, kind: "kit", version: manifest.version, channel, sourceCommit: provenance.sourceCommit,
    releaseCommit: commit, minimumBridgeVersion, url, sha256: digest(bytes), size: bytes.length, keyId };
  const descriptor = { ...body, signature: sign(null, Buffer.from(canonicalArtifact(body)), privateKey).toString("base64") };
  mkdirSync(outputDirectory, { recursive: true });
  const archivePath = join(outputDirectory, "proto-kit.tar.gz");
  const descriptorPath = join(outputDirectory, "kit-artifact.json");
  writeFileSync(archivePath, bytes);
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + "\n");
  return { descriptor, prefix, archivePath, descriptorPath };
}

/** No clobber: a retry may confirm identical objects, never rewrite a release. */
export async function uploadKitArtifact(artifact, { bucket, endpoint, run = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }) {
  if (!bucket || !/^[a-z0-9][a-z0-9.-]*$/.test(bucket)) throw new Error("Missing or invalid update bucket");
  const origin = new URL(endpoint);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash) throw new Error("Update storage endpoint requires HTTPS");
  const scratch = mkdtempSync(join(tmpdir(), "proto-artifact-upload-"));
  try {
    for (const path of [artifact.archivePath, artifact.descriptorPath]) {
      const name = path === artifact.archivePath ? "proto-kit.tar.gz" : "kit-artifact.json";
      const key = `${artifact.prefix}/${name}`;
      const downloaded = join(scratch, name);
      const existingMatches = async () => {
        try {
          await run("aws", ["s3api", "get-object", "--bucket", bucket, "--key", key, "--endpoint-url", endpoint, downloaded]);
        } catch (error) {
          if (!/NoSuchKey|Not Found|\b404\b/.test(String(error.stderr ?? error.message))) throw error;
          return false;
        }
        if (!readFileSync(downloaded).equals(readFileSync(path))) throw new Error(`Immutable update object already exists with different bytes: ${key}`);
        return true;
      };
      if (await existingMatches()) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          // The condition is checked atomically by R2, including when another
          // publisher creates the object after our initial read.
          await run("aws", ["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", path,
            "--endpoint-url", endpoint, "--if-none-match", "*",
            "--content-type", name.endsWith("json") ? "application/json" : "application/gzip", "--cache-control", "public,max-age=31536000,immutable"]);
          break;
        } catch (error) {
          if (!/PreconditionFailed|ConditionalRequestConflict|\b(?:409|412)\b/.test(String(error.stderr ?? error.message))) throw error;
          // A concurrent identical publication is an idempotent success. A
          // conflicting write can leave no object; retry only conditionally.
          if (await existingMatches()) break;
          if (attempt === 2) throw error;
        }
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  return artifact.descriptor;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scratch = mkdtempSync(join(tmpdir(), "proto-desktop-artifact-"));
  try {
    const channel = (process.env.GITHUB_REF ?? "").replace(/^refs\/heads\//, "");
    if (process.env.GITHUB_REPOSITORY !== "proto-labs-inc/proto-kit" || !validChannel(channel)) throw new Error("Desktop artifacts must be published by a proto-kit source branch");
    const artifact = buildKitArtifact({ cwd: process.cwd(), commit: process.env.PROTO_RELEASE_SHA, outputDirectory: scratch,
      signingKey: process.env.PROTO_ARTIFACT_SIGNING_KEY, keyId: process.env.PROTO_ARTIFACT_KEY_ID,
      baseURL: process.env.PROTO_UPDATES_BASE_URL, channel });
    await uploadKitArtifact(artifact, { bucket: process.env.PROTO_UPDATES_R2_BUCKET, endpoint: process.env.PROTO_UPDATES_R2_ENDPOINT });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `descriptor_url=${new URL("kit-artifact.json", artifact.descriptor.url).href}\n`);
    console.log(JSON.stringify({ status: "published", version: artifact.descriptor.version, channel, sha256: artifact.descriptor.sha256 }));
  } catch (error) {
    // Never include process environment or signed URLs in failure output.
    console.error(`Desktop kit artifact publication failed: ${error.message}`);
    process.exitCode = 1;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
