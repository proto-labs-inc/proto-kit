#!/usr/bin/env node
/**
 * Publish a prototype's built files (MAA-132, the publish half of
 * ADR 0001). This tool uploads a folder, nothing more: the session
 * builds first, with the workspace's own build script, and the
 * workspace's own config sets relative asset paths (the templates
 * carry base "./"). publish.mjs then asks the cloud to open a build
 * (`begin_publish` returns a fresh `<codebase>/<slug>/<buildId>/`
 * prefix and one short-lived presigned PUT URL per file), uploads
 * every file straight to the published host with plain HTTP PUTs,
 * closes the build (`finish_publish`), and prints the published URL.
 * Nothing passes through the app's own function, and no published
 * path is ever overwritten.
 *
 * Usage:
 *   node publish.mjs --kind prototype <workspace> [--dist <folder>] [--codebase <id>] [--slug <slug>] [--dry-run]
 *   node publish.mjs --kind library --codebase <id> [--dir <folder>] [--dry-run]
 *
 * --kind is required and names what is published. For a prototype,
 * --dist defaults to dist/; the folder must contain index.html and
 * prototype.json; codebase and slug default from the workspace path
 * (~/.proto/<codebase>/prototypes/<slug>/). The library is uploaded
 * as it stands (no slug): --dir defaults to ~/.proto/<codebase>/library
 * and must contain index.html and manifest.json. account comes from
 * ~/.proto/config.json. --dry-run prints the upload plan without
 * touching the cloud.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, extname, sep } from "node:path";
import { callTool, readConfig } from "./mcp-call.mjs";

const USAGE = `usage: node publish.mjs --kind prototype <workspace> [--dist <folder>] [--codebase <id>] [--slug <slug>] [--dry-run]
       node publish.mjs --kind library --codebase <id> [--dir <folder>] [--dry-run]`;
const KINDS = ["prototype", "library"];
const VALUE_OPTIONS = ["kind", "dist", "dir", "codebase", "slug"];
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const options = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--dry-run") {
    options.dryRun = true;
  } else if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (!VALUE_OPTIONS.includes(name) || args[i + 1] === undefined) fail(`unknown or valueless option ${arg}\n${USAGE}`);
    options[name] = args[i + 1];
    i += 1;
  } else {
    positional.push(arg);
  }
}
const kind = options.kind;
if (!KINDS.includes(kind)) fail(`--kind must be one of ${KINDS.join(", ")}; got ${kind ?? "nothing"}\n${USAGE}`);
const dryRun = options.dryRun === true;

// What is uploaded and where it belongs, by kind. A prototype's
// codebase and slug default from the canonical layout
// (~/.proto/<codebase>/prototypes/<slug>/), overridable for tests.
let codebase = options.codebase ?? null;
let workspace = null;
let slug = null;
let dist;
if (kind === "prototype") {
  if (!positional[0]) fail(USAGE);
  workspace = resolve(positional[0]);
  const parts = workspace.split(sep);
  const protoIdx = parts.lastIndexOf(".proto");
  const canonical = protoIdx !== -1 && parts[protoIdx + 2] === "prototypes";
  if (!codebase && canonical) codebase = parts[protoIdx + 1];
  dist = resolve(workspace, options.dist ?? "dist");
  slug = options.slug ?? null;
  if (!slug && canonical) slug = parts[protoIdx + 3];
  if (!slug) slug = JSON.parse(readFileSync(join(dist, "prototype.json"), "utf8")).name;
} else {
  if (!codebase) fail(`--kind library needs --codebase <id>\n${USAGE}`);
  dist = resolve(options.dir ?? join(process.env.HOME ?? "", ".proto", codebase, "library"));
}
if (!codebase && !dryRun) fail("cannot derive codebase from the workspace path; pass --codebase <id>");

// Upload-only: the session already built with the workspace's own
// build script. A publishable folder has an index.html, and a build
// that lives under a path must reference its assets relatively.
if (!existsSync(join(dist, "index.html"))) {
  if (kind === "library") fail(`${dist} has no index.html; is this a scaffolded library?`);
  else fail(`${dist} has no index.html; build the workspace first (its own build script), or pass --dist <folder>`);
}
if (kind === "library" && !existsSync(join(dist, "manifest.json"))) {
  fail(`${dist} has no manifest.json; a library without one has nothing imported yet`);
}
const indexHtml = readFileSync(join(dist, "index.html"), "utf8");
const rootAbsolute = [...indexHtml.matchAll(/(?:src|href)="(\/[^\/"][^"]*)"/g)].map((m) => m[1]);
if (rootAbsolute.length > 0) {
  console.error(`warning: index.html references root-absolute asset paths (${rootAbsolute.slice(0, 3).join(", ")}${rootAbsolute.length > 3 ? ", …" : ""}).`);
  console.error("A published build lives under a path; set relative asset paths in the workspace's build config (the templates use base \"./\").");
}

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(dist);

// Bare media types: the publish schema and the presigned signatures
// use exact types with no parameters.
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wasm": "application/wasm",
};
const typeFor = (path) => TYPES[extname(path)] ?? "application/octet-stream";

// The files manifest begin_publish wants: relative posix paths with
// content type and size. Mirror the server's limits here so failures
// are one plain sentence instead of a round trip.
const manifest = files.map((f) => ({
  path: relative(dist, f).split(sep).join("/"),
  contentType: typeFor(f),
  size: statSync(f).size,
}));
const totalBytes = manifest.reduce((n, f) => n + f.size, 0);
let distLabel = dist;
if (kind === "prototype") distLabel = relative(workspace, dist) || "dist";
console.log(`${manifest.length} files, ${(totalBytes / 1024).toFixed(0)} KB in ${distLabel}`);
const problems = [];
if (kind === "prototype" && !manifest.some((f) => f.path === "prototype.json"))
  problems.push("the build has no prototype.json (the workspace's public/ folder should carry it)");
if (manifest.length > 200) problems.push(`${manifest.length} files; the limit is 200`);
if (totalBytes > 40 * 1024 * 1024) problems.push(`${(totalBytes / 1048576).toFixed(1)} MB total; the limit is 40 MB`);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
for (const f of manifest) {
  if (f.size > 8 * 1024 * 1024) problems.push(`${f.path} is ${(f.size / 1048576).toFixed(1)} MB; the per-file limit is 8 MB`);
  if (!f.path.split("/").every((seg) => SEGMENT.test(seg)))
    problems.push(`${f.path} has a path segment the published host refuses (letters, digits, dot, dash, underscore; no leading dot)`);
}
if (problems.length > 0) {
  for (const p of problems) console.error(`cannot publish: ${p}`);
  process.exit(1);
}

if (dryRun) {
  for (const f of manifest) console.log(`  would upload ${f.path}  (${f.contentType}, ${f.size} bytes)`);
  console.log("dry run: skipped begin_publish, uploads, finish_publish");
  process.exit(0);
}

// The MCP tools answer with JSON in content[0].text; validation
// failures arrive as plain text there instead.
const unwrap = (result) => {
  const text = result?.content?.[0]?.text;
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.split("\n")[0] };
  }
};

let config;
try {
  config = readConfig();
} catch (e) {
  fail(e.message);
}
const account = config.account?.user;
// The target both publish tools key on: the kind and codebase, plus
// the slug for a prototype.
let target;
if (kind === "prototype") target = { kind, codebase, slug };
else target = { kind, codebase };
const opened = unwrap(
  await callTool("begin_publish", { ...target, account, files: manifest }).catch((e) => ({
    content: [{ text: e.message }],
  })),
);
if (!opened.buildId || !Array.isArray(opened.uploads)) {
  console.error(`begin_publish did not open a build: ${opened.error ?? JSON.stringify(opened)}`);
  process.exit(1);
}
const { buildId, pathnamePrefix, uploads } = opened;
console.log(`build ${buildId} → ${pathnamePrefix} (${uploads.length} upload URLs)`);

// One presigned PUT URL per file, each bound to its exact object,
// content type and size; the URLs live ten minutes, so upload in
// parallel and fail plainly on the first refusal. Bodies must be
// Buffers, never streams: Content-Length is one of the signed
// headers, and a chunked body has no length, so streaming always
// fails the signature (403 SignatureDoesNotMatch).
const results = await Promise.all(
  uploads.map(async (upload) => {
    const res = await fetch(upload.url, {
      method: "PUT",
      body: readFileSync(join(dist, upload.path)),
      headers: { "Content-Type": upload.contentType },
    }).catch((e) => ({ ok: false, status: e.message }));
    if (res.ok) console.log(`  uploaded ${upload.path}`);
    return { path: upload.path, ok: res.ok, status: res.status };
  }),
);
const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  for (const f of failed) console.error(`upload failed: ${f.path} (${f.status})`);
  console.error("nothing was finished; run publish again for a fresh build");
  process.exit(1);
}

const finished = unwrap(
  await callTool("finish_publish", { ...target, buildId, account }).catch((e) => ({
    content: [{ text: e.message }],
  })),
);
if (!finished.publishedUrl) {
  console.error(`finish_publish did not confirm: ${finished.error ?? JSON.stringify(finished)}`);
  process.exit(1);
}
console.log(`published: ${finished.publishedUrl}`);
if (kind === "library") console.log(`the app loads ${finished.publishedUrl}index.html and ${finished.publishedUrl}manifest.json`);
else console.log(`the Frame loads ${finished.publishedUrl}index.html and ${finished.publishedUrl}prototype.json`);
