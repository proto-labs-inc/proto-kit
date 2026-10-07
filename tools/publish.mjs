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
 * (~/.proto/<codebase>/prototypes/<slug>/). The library is an app
 * too (ADR 0003) and is uploaded as its build (no slug): --dir
 * defaults to ~/.proto/<codebase>/library/dist, produced by `pnpm
 * build` in the library folder, and must contain index.html and a
 * manifest.json naming a codebase. The laptop token in
 * ~/.proto/config.json identifies the member and team. --dry-run prints the upload plan without
 * touching the cloud.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, relative, extname, sep } from "node:path";
import { workflowEvent, activityEvent } from "./workflow-report.mjs";
import { buildOfWorkspace } from "./build-folder.mjs";
import { createReporter } from "./build-report.mjs";
import { capturePublishedPreview } from "./publish-preview.mjs";
import { callTool, readConfig } from "./mcp-call.mjs";
import { validatePublishedManifest } from "./variant-manifest.mjs";
import { IDENTITY_FILE } from "./dev-server.mjs";

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
  dist = resolve(options.dir ?? join(process.env.HOME ?? "", ".proto", codebase, "library", "dist"));
}
if (!codebase && !dryRun) fail("cannot derive codebase from the workspace path; pass --codebase <id>");

// Upload-only: the session already built with the workspace's own
// build script. A publishable folder has an index.html, and a build
// that lives under a path must reference its assets relatively.
if (!existsSync(join(dist, "index.html"))) {
  if (kind === "library") fail(`${dist} has no index.html; build the library first (pnpm build in its folder), or pass --dir <folder>`);
  else fail(`${dist} has no index.html; build the workspace first (its own build script), or pass --dist <folder>`);
}
if (kind === "library") {
  const manifestPath = join(dist, "manifest.json");
  if (!existsSync(manifestPath)) fail(`${dist} has no manifest.json; the library's public/ folder should carry it`);
  if (JSON.parse(readFileSync(manifestPath, "utf8")).codebase === null) {
    fail(`${dist}/manifest.json names no codebase; a library with nothing imported has nothing to publish`);
  }
}
// Validate before credentials, capture, or any network request.
if (kind === "prototype") {
  try { validatePublishedManifest(workspace, dist); }
  catch (error) { fail(`cannot publish: ${error.message}`); }
}
// What a build carries that is never published: the workspace's
// identity record (public/__proto-workspace.json, the local dev server's
// token; tools/dev-server.mjs), and Internet Explorer's .eot fonts that
// stylesheets captured before snapshot.mjs dropped them still list. No
// current browser loads an .eot, and the host refuses the type.
const leftOut = [];
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if ((dir === dist && entry.name === IDENTITY_FILE) || extname(entry.name).toLowerCase() === ".eot") leftOut.push(relative(dist, full));
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
  ".jsonl": "text/plain",
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
if (leftOut.length) console.log(`left out (never published): ${leftOut.join(", ")}`);
const problems = [];
if (kind === "prototype" && !manifest.some((f) => f.path === "prototype.json"))
  problems.push("the build has no prototype.json (the workspace's public/ folder should carry it)");
if (manifest.length > 200) problems.push(`${manifest.length} files; the limit is 200`);
if (totalBytes > 40 * 1024 * 1024) problems.push(`${(totalBytes / 1048576).toFixed(1)} MB total; the limit is 40 MB`);
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
for (const f of manifest) {
  if (f.size > 8 * 1024 * 1024) problems.push(`${f.path} is ${(f.size / 1048576).toFixed(1)} MB; the per-file limit is 8 MB`);
  if (!f.path.split("/").every((seg) => SEGMENT.test(seg)))
    problems.push(`${f.path} has a path segment the published host refuses (each part of a path must start with a letter or digit, then letters, digits, dot, dash or underscore)`);
}
// Every asset reference must resolve against the build's own base. A
// published build lives under <codebase>/<slug>/<buildId>/, so a
// root-absolute reference ("/portraits/soleio.jpg") resolves against the
// host root instead and 404s, while the same build serves fine in dev and
// through the tunnel, where the workspace is the host root. The templates'
// vite base "./" rewrites every reference the bundler sees (HTML
// attributes, CSS url(), imported assets); a path written as a string
// literal in application data is invisible to it and ships unchanged.
// This is the gate every build passes through, so the rule lives here: a
// root-absolute reference naming a file this build carries is unsafe once
// published. Match against the build's own files and nothing else. In
// application code, prefix a public/ file with import.meta.env.BASE_URL or
// import it. In prototype.json, keep preview, reference-image and wireframe
// values relative without a leading slash; the Frame resolves them against
// the live or published prototype base, and Vite may also inline them into
// the application bundle.
const SCANNED = new Set([".html", ".js", ".mjs", ".css", ".json"]);
const carried = new Set(manifest.map((f) => f.path));
const misrooted = new Map();
for (const f of manifest) {
  if (!SCANNED.has(extname(f.path))) continue;
  const text = readFileSync(join(dist, f.path), "utf8");
  for (const [, ref] of text.matchAll(/["'`(](\/[A-Za-z0-9._][A-Za-z0-9._\-/]*)/g)) {
    if (!carried.has(ref.slice(1))) continue;
    if (!misrooted.has(ref)) misrooted.set(ref, new Set());
    misrooted.get(ref).add(f.path);
  }
}
for (const [ref, sources] of misrooted) {
  problems.push(
    `${[...sources].sort().join(", ")} reference${sources.size > 1 ? "" : "s"} ${ref} root-absolutely; the build carries that file, so published it can resolve to the host root and 404. Use import.meta.env.BASE_URL in application code, or remove the leading slash in prototype.json`,
  );
}

if (problems.length > 0) {
  for (const p of problems) console.error(`cannot publish: ${p}`);
  process.exit(1);
}

if (dryRun) {
  for (const f of manifest) console.log(`  would upload ${f.path}  (${f.contentType}, ${f.size} bytes)`);
  console.log(`every asset reference resolves against the build's base (${manifest.filter((f) => SCANNED.has(extname(f.path))).length} text files scanned)`);
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

// A laptop that is not linked fails here, before anything is uploaded.
try {
  readConfig();
} catch (e) {
  fail(e.message);
}
// The target both publish tools key on: the kind and codebase, plus
// the slug for a prototype.
let target;
if (kind === "prototype") target = { kind, codebase, slug };
else target = { kind, codebase };

// A prototype publish records which rig it was built with, so the app
// knows which message contract the published build speaks: the version
// of the @proto-labs-inc/rig-core the workspace's adapter resolves.
let rigVersion = null;
if (kind === "prototype") rigVersion = resolvedRigVersion(workspace);
let progressBuild = kind === "prototype" ? buildOfWorkspace(workspace) : null;
if (progressBuild) {
  const response = await callTool("get_brief", { briefId: progressBuild.briefId });
  const brief = unwrap(response);
  if (response?.isError || !brief.status) throw new Error("Could not verify the saved request before publishing");
  // Re-publishing an existing prototype never reopens its completed request.
  if (brief.status === "done") progressBuild = null;
}
const progress = progressBuild ? createReporter({ codebase, briefId: progressBuild.briefId, runDir: progressBuild.dir }) : null;
const publishing = progressBuild ? workflowEvent(progressBuild.dir, "publish", "Publishing the prototype") : null;
try {
if (progress) {
  progress.send([publishing, activityEvent(publishing, "publish-capture", "active", "Capturing the final prototype", "Capturing the built page before upload")]);
  await progress.flush();
  await capturePublishedPreview(dist, progressBuild, progress, publishing.revision);
  progress.send([activityEvent(publishing, "publish-capture", "completed", "Captured the final prototype", "Saved the clean final preview"), activityEvent(publishing, "publish-upload", "active", "Uploading the prototype", `Uploading ${manifest.length} files`)]);
  await progress.flush();
}
const opened = unwrap(
  await callTool("begin_publish", { ...target, files: manifest }).catch((e) => ({
    content: [{ text: e.message }],
  })),
);
if (!opened.buildId || !Array.isArray(opened.uploads)) {
  throw new Error(`Could not prepare publishing: ${opened.error ?? "the app did not return upload targets"}`);
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
  throw new Error("Publishing failed; the build remains unfinished");
}

const finishInput = { ...target, buildId };
if (kind === "prototype") finishInput.rigVersion = rigVersion;
const finished = unwrap(
  await callTool("finish_publish", finishInput).catch((e) => ({
    content: [{ text: e.message }],
  })),
);
if (!finished.publishedUrl) {
  throw new Error(`Could not verify publishing: ${finished.error ?? "the app did not confirm availability"}`);
}
console.log(`published: ${finished.publishedUrl}`);
if (kind === "library") console.log(`the app loads ${finished.publishedUrl}index.html and ${finished.publishedUrl}manifest.json`);
else console.log(`the Frame loads ${finished.publishedUrl}index.html and ${finished.publishedUrl}prototype.json`);
if (progress) {
  progress.send([
    activityEvent(publishing, "publish-upload", "completed", "Uploaded the prototype", "Saved the published build"),
    activityEvent(publishing, "publish-availability", "completed", "Verified availability", "Confirmed the published page is available"),
    workflowEvent(progressBuild.dir, "publish", "Published the prototype", "completed"),
  ]);
  await progress.flush();
  const completed = await callTool("report_progress", { briefId: progressBuild.briefId, status: "done", prototypeSlug: slug, message: "Published and verified" });
  if (completed?.isError) throw new Error(completed.content?.[0]?.text ?? "Completion report failed");
}
} catch (error) {
  if (progress) {
    progress.send([workflowEvent(progressBuild.dir, "publish", error.message.slice(0, 200), "failed"), activityEvent(publishing, "publish-result", "failed", "Publishing failed", error.message.slice(0, 1000))]);
    await progress.flush().catch(() => {});
    await callTool("report_progress", { briefId: progressBuild.briefId, status: "failed", message: error.message }).catch(() => {});
  }
  throw error;
}
// The adapter is the workspace's own dependency; rig-core is the
// adapter's, so it is resolved from there, wherever the package
// manager put it.
function resolvedRigVersion(workspace) {
  const own = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).dependencies ?? {};
  const adapter = ["@proto-labs-inc/rig", "@proto-labs-inc/rig-vue"].find((name) => name in own);
  if (!adapter) fail(`${workspace}/package.json depends on neither @proto-labs-inc/rig nor @proto-labs-inc/rig-vue`);
  try {
    const adapterPackage = createRequire(join(workspace, "package.json")).resolve(`${adapter}/package.json`);
    const corePackage = createRequire(adapterPackage).resolve("@proto-labs-inc/rig-core/package.json");
    return JSON.parse(readFileSync(corePackage, "utf8")).version;
  } catch {
    fail(`@proto-labs-inc/rig-core does not resolve from ${workspace}; run pnpm install there first`);
  }
}
