#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { callTool } from "./mcp-call.mjs";
import {
  packScreen,
  cloneScreen,
  sha256,
  screenDependencies,
  unpackScreen,
} from "./screen-bundle.mjs";

// All calls include codebase for credential selection, even when the server
// identifies the target through indexId or screenId.
const [command, codebase, ...rest] = process.argv.slice(2);
if (!/^[a-z0-9][a-z0-9-]*$/.test(codebase ?? ""))
  throw new Error(
    "usage: screen-index.mjs <capture|upload|clone|call> <codebase> ...",
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
let answer;
if (command === "snapshot") {
  const [folder,briefId]=rest;
  if(!/^[a-zA-Z0-9-]+$/.test(briefId ?? '')) throw new Error('A saved brief ID is required.');
  const destination=join(process.env.HOME,'.proto',codebase,'screens','custom-requests',briefId);
  const bytes=packScreen(folder);
  if(!existsSync(destination)) unpackScreen(bytes,sha256(bytes),destination);
  answer={path:destination};
} else if (command === "call")
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
  answer = { screenId: answer.screen.id, status: answer.screen.status };
} else if (command === "clone") {
  const [screenId, slug, briefId] = rest;
  const { screen, downloadUrl } = await invoke({
    operation: "download",
    screenId,
  });
  if (screen.codebase !== codebase)
    throw new Error("Starter belongs to a different codebase.");
  const root = join(process.env.HOME, ".proto", codebase);
  const cache = join(root, "screens", screenId);
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, `${screen.bundle_checksum}.json.gz`);
  let bytes = existsSync(archive) ? readFileSync(archive) : null;
  if (!bytes || sha256(bytes) !== screen.bundle_checksum) {
    const response = await fetch(downloadUrl);
    if (!response.ok)
      throw new Error(
        "Could not download the starter. Retry the same request.",
      );
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== screen.bundle_checksum)
      throw new Error("Source checksum mismatch.");
    writeFileSync(archive, bytes);
  }
  const cachedSource = join(cache, "source");
  if (!existsSync(cachedSource))
    unpackScreen(bytes, screen.bundle_checksum, cachedSource);
  answer = await cloneScreen(bytes, screen, {
    destination: join(root, "prototypes", slug),
    slug,
    codebase,
    briefId,
  });
} else throw new Error("Unknown screen-index command.");
console.log(JSON.stringify(answer, null, 2));
