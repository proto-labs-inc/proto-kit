#!/usr/bin/env node
/**
 * Publish a prototype's built files (MAA-132, the publish half of
 * ADR 0001). This tool uploads a folder, nothing more: the session
 * builds first, with the workspace's own build script, and the
 * workspace's own config sets relative asset paths (the templates
 * carry base "./"). publish.mjs then asks the cloud to open a build
 * (`begin_publish` returns a fresh `<product>/<slug>/<buildId>/`
 * prefix and a short-lived client token), uploads every file
 * straight to Vercel Blob with that token, closes the build
 * (`finish_publish`), and prints the published URL. Nothing passes
 * through the app's own function, and no published path is ever
 * overwritten.
 *
 * Usage: node publish.mjs <workspace> [--dist <folder>] [--product <id>] [--slug <slug>] [--dry-run]
 *   --dist defaults to dist/. It must contain index.html. product
 *   and slug default from the workspace path
 *   (~/.proto/<product>/prototypes/<slug>/); account comes from
 *   ~/.proto/config.json. --dry-run prints the upload plan without
 *   touching the cloud.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, extname, sep } from "node:path";
import { callTool } from "./mcp-call.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1];
};
const dryRun = args.includes("--dry-run");
const workspace = resolve(args.find((a) => !a.startsWith("--")) ?? "");
if (!args[0]) {
  console.error("usage: node publish.mjs <workspace> [--product <id>] [--slug <slug>] [--dry-run]");
  process.exit(1);
}

// product/slug from the canonical layout, overridable for tests.
const parts = workspace.split(sep);
const protoIdx = parts.lastIndexOf(".proto");
const product =
  flag("product") ?? (protoIdx !== -1 && parts[protoIdx + 2] === "prototypes" ? parts[protoIdx + 1] : null);
const dist = resolve(workspace, flag("dist") ?? "dist");
const slug =
  flag("slug") ??
  (protoIdx !== -1 && parts[protoIdx + 2] === "prototypes"
    ? parts[protoIdx + 3]
    : JSON.parse(readFileSync(join(dist, "prototype.json"), "utf8")).name);
if (!product && !dryRun) {
  console.error("cannot derive product from the workspace path; pass --product <id>");
  process.exit(1);
}

const config = (() => {
  try {
    return JSON.parse(readFileSync(join(process.env.HOME ?? "", ".proto", "config.json"), "utf8"));
  } catch {
    return {};
  }
})();

// Upload-only: the session already built with the workspace's own
// build script. A publishable folder has an index.html, and a build
// that lives under a path must reference its assets relatively.
if (!existsSync(join(dist, "index.html"))) {
  console.error(`${dist} has no index.html; build the workspace first (its own build script), or pass --dist <folder>`);
  process.exit(1);
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

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
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
console.log(`${manifest.length} files, ${(totalBytes / 1024).toFixed(0)} KB in ${relative(workspace, dist) || "dist"}/`);
const problems = [];
if (!manifest.some((f) => f.path === "prototype.json"))
  problems.push("the build has no prototype.json (the workspace's public/ folder should carry it)");
if (manifest.length > 200) problems.push(`${manifest.length} files; the limit is 200`);
if (totalBytes > 40 * 1024 * 1024) problems.push(`${(totalBytes / 1048576).toFixed(1)} MB total; the limit is 40 MB`);
for (const f of manifest) {
  if (f.size > 8 * 1024 * 1024) problems.push(`${f.path} is ${(f.size / 1048576).toFixed(1)} MB; the per-file limit is 8 MB`);
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

// The MCP tools answer with JSON in content[0].text.
const unwrap = (result) => {
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : result;
};

const account = config.account?.user;
const opened = unwrap(await callTool("begin_publish", { product, slug, account, files: manifest }));
if (!opened.buildId || !Array.isArray(opened.uploads)) {
  console.error(`begin_publish did not open a build: ${JSON.stringify(opened)}`);
  process.exit(1);
}
const { buildId, pathnamePrefix, uploads } = opened;
console.log(`build ${buildId} → ${pathnamePrefix} (${uploads.length} upload tokens)`);

// One token per file, each bound to its exact pathname, content type
// and size; the tokens live ten minutes, so upload in parallel.
const { put } = await import("@vercel/blob/client");
await Promise.all(
  uploads.map(async (upload) => {
    await put(upload.pathname, readFileSync(join(dist, upload.path)), {
      access: "public",
      token: upload.token,
      contentType: upload.contentType,
    });
    console.log(`  uploaded ${upload.path}`);
  }),
);

const finished = unwrap(await callTool("finish_publish", { product, slug, buildId, account }));
if (!finished.publishedUrl) {
  console.error(`finish_publish did not confirm: ${JSON.stringify(finished)}`);
  process.exit(1);
}
console.log(`published: ${finished.publishedUrl}`);
console.log(`the Frame loads ${finished.publishedUrl}index.html and ${finished.publishedUrl}prototype.json`);
