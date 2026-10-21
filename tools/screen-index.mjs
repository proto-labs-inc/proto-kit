#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { verifyBuild, smokeBuild } from "./verify-screen.mjs";
import { validateVerification } from "./screen-verification.mjs";
import { unpackScreenBuild } from "./screen-build.mjs";
import { packScreenBuild } from "./screen-build.mjs";
import { join } from "node:path";
import { callTool } from "./mcp-call.mjs";
import {
  packScreen,
  cloneScreen,
  sha256,
  screenDependencies,
  unpackScreen,
} from "./screen-bundle.mjs";
import { protoHome } from "./proto-home.mjs";

// All calls include codebase for credential selection, even when the server
// identifies the target through indexId or screenId.
const [command, codebase, ...rest] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]*$/.test(codebase ?? ""))
  throw new Error(
    "usage: screen-index.mjs <capture|upload|prepare|verify|reverify|clone|call> <codebase> ...",
  );
async function invoke(args) {
  const result = await callTool("screen_index", { ...args, codebase });
  const text = result.content
    ?.filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (result.isError) throw new Error(text || "Screen indexing failed.");
  return JSON.parse(text);
}
async function put(url, bytes) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(bytes.length),
    },
    body: bytes,
  });
  if (!response.ok)
    throw new Error(`Artifact upload failed (${response.status}).`);
}
async function download(url, checksum, archive) {
  if (existsSync(archive)) {
    const bytes = readFileSync(archive);
    if (sha256(bytes) === checksum) return bytes;
  }
  const response = await fetch(url);
  if (!response.ok)
    throw new Error("Could not download the starter. Retry the same request.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== checksum)
    throw new Error("Starter artifact checksum mismatch.");
  mkdirSync(join(archive, ".."), { recursive: true });
  writeFileSync(archive, bytes);
  return bytes;
}
async function prepare(screen, bytes) {
  if (screen.metadata?.preparedBuild)
    return { screenId: screen.id, status: "prepared", reused: true };
  const temporary = mkdtempSync(join(tmpdir(), "proto-prepare-screen-"));
  const source = join(temporary, "source");
  try {
    // Compile the exact archived source, never an edited working folder or stale dist.
    unpackScreen(bytes, screen.bundle_checksum, source);
    let manager = "npm";
    let install = ["ci"];
    if (existsSync(join(source, "pnpm-lock.yaml"))) {
      manager = "pnpm";
      install = ["install", "--frozen-lockfile"];
    } else if (existsSync(join(source, "yarn.lock"))) {
      manager = "yarn";
      install = ["install", "--frozen-lockfile"];
    }
    for (const args of [install, ["run", "build"]]) {
      const result = spawnSync(manager, args, {
        cwd: source,
        stdio: ["ignore", 2, 2],
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`Starter ${manager} ${args[0]} failed.`);
    }
    const build = packScreenBuild(join(source, "dist"), screen.bundle_checksum);
    const args = {
      screenId: screen.id,
      sourceChecksum: screen.bundle_checksum,
      checksum: sha256(build),
    };
    const upload = await invoke({
      operation: "build-upload",
      ...args,
      size: build.length,
    });
    if (upload.uploadUrl) await put(upload.uploadUrl, build);
    await invoke({ operation: "build-finish", ...args });
    return { screenId: screen.id, status: "prepared", reused: false };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
let answer;
if (command === "call")
  answer = await invoke(JSON.parse(readFileSync(rest[0], "utf8")));
else if (command === "capture") {
  const [indexId, file] = rest;
  const bytes = readFileSync(file);
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    throw new Error("Capture must be a PNG.");
  answer = await invoke({
    operation: "capture",
    indexId,
    checksum: sha256(bytes),
    size: bytes.length,
  });
  await put(answer.uploadUrl, bytes);
  answer = { key: answer.key };
} else if (command === "upload") {
  const [indexId, version, entryId, folder] = rest;
  const bytes = packScreen(folder);
  answer = await invoke({
    operation: "upload",
    indexId,
    version: Number(version),
    entryId,
    checksum: sha256(bytes),
    size: bytes.length,
    metadata: { format: "proto-screen-v1", ...screenDependencies(folder) },
  });
  if (answer.uploadUrl) await put(answer.uploadUrl, bytes);
  let archivedBytes = bytes;
  if (answer.screen.bundle_checksum !== sha256(bytes)) {
    const saved = await invoke({
      operation: "inspect",
      screenId: answer.screen.id,
    });
    const response = await fetch(saved.downloadUrl);
    if (!response.ok)
      throw new Error("Could not download the existing starter.");
    archivedBytes = Buffer.from(await response.arrayBuffer());
  }
  const prepared = await prepare(answer.screen, archivedBytes);
  answer = { ...prepared, status: answer.screen.status };
} else if (command === "verify" || command === "reverify") {
  const [screenId, planFile] = rest;
  const { screen, buildDownloadUrl } = await invoke({ operation: "inspect", screenId });
  if (screen.codebase !== codebase || !buildDownloadUrl) throw new Error("Prepare this screen's compiled build first.");
  const cache = join(protoHome(), codebase, "screens", screenId);
  const prepared = screen.metadata.preparedBuild;
  const bytes = await download(buildDownloadUrl, prepared.checksum, join(cache, `${prepared.checksum}.build.json.gz`));
  const temporary = mkdtempSync(join(tmpdir(), "proto-verify-screen-"));
  try {
    unpackScreenBuild(bytes, prepared.checksum, screen.bundle_checksum, join(temporary, "dist"));
    const report = await verifyBuild(join(temporary, "dist"), JSON.parse(readFileSync(planFile, "utf8")), screen, join(cache, "verification", prepared.checksum));
    if (report.scenarios.some(s => s.outcome !== "passed")) throw new Error("Screen verification failed. Inspect the saved report and repair the source before uploading a new build.");
    for (const scenario of report.scenarios) {
      const keys = [];
      for (const path of scenario.evidence) {
        const file = readFileSync(path);
        const capture = await invoke({ operation: "capture", indexId: screen.index_id, checksum: sha256(file), size: file.length });
        await put(capture.uploadUrl, file);
        keys.push(capture.key);
      }
      scenario.evidence = keys;
    }
    validateVerification(report, screen);
    answer = await invoke({ operation: command === "reverify" ? "reverify" : "finish", screenId, verification: report });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else if (command === "clone" || command === "prepare") {
  const [screenId, slug, briefId] = rest;
  const { screen, downloadUrl, buildDownloadUrl } = await invoke({
    operation: command === "clone" ? "download" : "inspect",
    screenId,
  });
  if (screen.codebase !== codebase)
    throw new Error("Starter belongs to a different codebase.");
  const root = join(protoHome(), codebase);
  const cache = join(root, "screens", screenId);
  const bytes = await download(
    downloadUrl,
    screen.bundle_checksum,
    join(cache, `${screen.bundle_checksum}.json.gz`),
  );
  if (command === "prepare") answer = await prepare(screen, bytes);
  else {
    const prepared = screen.metadata?.preparedBuild;
    if (!prepared || !buildDownloadUrl)
      throw new Error(
        "This starter needs a prepared build. Run screen-index.mjs prepare for this screen first.",
      );
    const buildBytes = await download(
      buildDownloadUrl,
      prepared.checksum,
      join(cache, `${prepared.checksum}.build.json.gz`),
    );
    validateVerification(screen.metadata.verification, screen);
    answer = await cloneScreen(bytes, screen, {
      destination: join(root, "prototypes", slug),
      slug,
      codebase,
      briefId,
      buildBytes,
    });
    await smokeBuild(join(answer.path, "dist"), screen.initial_state);
  }
} else throw new Error("Unknown screen-index command.");
console.log(JSON.stringify(answer, null, 2));
