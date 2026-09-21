#!/usr/bin/env node
/**
 * Publish a prototype workspace as a static build (MAA-132, the
 * publish half of ADR 0001). Runs `vite build --base ./` in the
 * workspace (relative asset paths, so the build works at any URL
 * path), asks the cloud to open a build (`begin_publish` returns a
 * fresh `<product>/<slug>/<buildId>/` prefix and a short-lived client
 * token), uploads every file in dist/ straight to Vercel Blob with
 * that token, then closes the build (`finish_publish`) and prints the
 * published URL. The build never passes through the app's own
 * function.
 *
 * Usage: node publish.mjs <workspace> [--product <id>] [--slug <slug>] [--dry-run]
 *   product and slug default from the workspace path
 *   (~/.proto/<product>/prototypes/<slug>/); account comes from
 *   ~/.proto/config.json. --dry-run builds and prints the upload plan
 *   without touching the cloud.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
const slug =
  flag("slug") ??
  (protoIdx !== -1 && parts[protoIdx + 2] === "prototypes"
    ? parts[protoIdx + 3]
    : JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8")).name);
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

// Build. The rig resolves from package source through the workspace's
// own vite config, which reads PROTO_PACKAGES (pre-npm).
console.log(`building ${slug} (vite build --base ./) …`);
const build = spawnSync(join(workspace, "node_modules", ".bin", "vite"), ["build", "--base", "./"], {
  cwd: workspace,
  encoding: "utf8",
  env: { ...process.env, ...(config.packages ? { PROTO_PACKAGES: config.packages } : {}) },
});
if (build.status !== 0) {
  console.error("build failed:");
  console.error((build.stderr || build.stdout || "").trim().split("\n").slice(-15).join("\n"));
  process.exit(1);
}
console.log((build.stdout ?? "").trim().split("\n").slice(-3).join("\n"));

const dist = join(workspace, "dist");
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
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};
const typeFor = (path) => TYPES[extname(path)] ?? "application/octet-stream";

const totalBytes = files.reduce((n, f) => n + statSync(f).size, 0);
console.log(`${files.length} files, ${(totalBytes / 1024).toFixed(0)} KB in dist/`);

if (dryRun) {
  for (const f of files) console.log(`  would upload ${relative(dist, f)}  (${typeFor(f)})`);
  console.log("dry run: skipped begin_publish, uploads, finish_publish");
  process.exit(0);
}

// The MCP tools answer with JSON in content[0].text.
const unwrap = (result) => {
  const text = result?.content?.[0]?.text;
  return text ? JSON.parse(text) : result;
};

const account = config.account?.user;
const opened = unwrap(await callTool("begin_publish", { product, slug, account }));
if (!opened.buildId) {
  console.error(`begin_publish did not open a build: ${JSON.stringify(opened)}`);
  process.exit(1);
}
const { buildId, pathnamePrefix, clientToken } = opened;
console.log(`build ${buildId} → ${pathnamePrefix}`);

const { put } = await import("@vercel/blob/client");
for (const file of files) {
  const rel = relative(dist, file).split(sep).join("/");
  await put(pathnamePrefix + rel, readFileSync(file), {
    access: "public",
    token: clientToken,
    addRandomSuffix: false,
    contentType: typeFor(file),
  });
  console.log(`  uploaded ${rel}`);
}

const finished = unwrap(await callTool("finish_publish", { product, slug, buildId, account }));
if (!finished.url) {
  console.error(`finish_publish did not confirm: ${JSON.stringify(finished)}`);
  process.exit(1);
}
console.log(`published: ${finished.url}`);
