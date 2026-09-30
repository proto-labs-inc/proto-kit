#!/usr/bin/env node
/**
 * Scaffold a prototype workspace from a build's read, in one call, so
 * the agent never edits package.json, ports or tsconfig by hand.
 *
 * Usage: node tools/scaffold.mjs <slug> --codebase <id> --brief <briefId> [--title "<title>"]
 *
 * Creates ~/.proto/<codebase>/prototypes/<slug>/ from the workspace
 * template matching the source repo's framework (vue in its package.json
 * → template/workspace-vue, else template/workspace-react), then:
 *   - names it: package.json name, index.html title, prototype.json name;
 *   - picks a free port no other workspace of the codebase uses and
 *     writes it into vite.config.ts and prototype.json, which must agree;
 *   - writes the rig's source paths into tsconfig.json (the rig resolves
 *     through PROTO_PACKAGES until it publishes to npm, MAA-216);
 *   - writes the page's tokens (the custom properties the read captured
 *     on :root and body) to src/tokens.css, its @font-face rules to
 *     src/fonts.css with the files in src/fonts/, and the body's own face
 *     and colours into src/styles.css;
 *   - wires Tailwind (the plugin and the import) when the source uses it;
 *   - installs with pnpm from the shared store, offline first.
 * Idempotent: a workspace that exists keeps its port and its files;
 * only the derived tokens and fonts are written again, and the install
 * runs only when node_modules is missing or the lockfile changed.
 *
 * Records the workspace in the build folder (workspace.json) so
 * tools/replicate.mjs finds it from the brief. Prints one JSON line:
 * { slug, path, port, framework, tailwind, seconds, install }.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const USAGE = 'usage: node tools/scaffold.mjs <slug> --codebase <id> --brief <briefId> [--title "<title>"]';
const started = Date.now();

const options = {};
const positional = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) {
    options[args[i].slice(2)] = args[i + 1];
    i += 1;
  } else positional.push(args[i]);
}
const [slug] = positional;
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!slug || !options.codebase || !options.brief) fail(USAGE);
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail("the slug is lowercase letters, digits and dashes: it becomes the subdomain label");

const homeDir = process.env.HOME ?? "";
const home = join(homeDir, ".proto", options.codebase);
const buildDir = join(home, "run", "builds", options.brief);
const readPath = join(buildDir, "read.json");
if (!existsSync(readPath)) fail(`${readPath} does not exist: run build-stream.mjs read first`);
const read = JSON.parse(readFileSync(readPath, "utf8"));
const codebaseRecord = JSON.parse(readFileSync(join(home, "codebase.json"), "utf8"));
const config = JSON.parse(readFileSync(join(homeDir, ".proto", "config.json"), "utf8"));
const packages = config.packages;
if (!packages) fail("~/.proto/config.json names no packages folder: the rig cannot resolve (setup writes it)");

// ---- which template, and whether the source uses Tailwind ----
const sourcePath = codebaseRecord.source?.path;
let sourcePackage = {};
try {
  sourcePackage = JSON.parse(readFileSync(join(sourcePath, "package.json"), "utf8"));
} catch {}
const sourceDeps = { ...sourcePackage.dependencies, ...sourcePackage.devDependencies };
const framework = "vue" in sourceDeps ? "vue" : "react";
const tailwind = framework === "react" && usesTailwind(sourcePath, sourceDeps);
const template = join(kit, "template", `workspace-${framework}`);

// ---- the folder ----
const workspaces = join(home, "prototypes");
const workspace = join(workspaces, slug);
const fresh = !existsSync(join(workspace, "package.json"));
// A folder that exists belongs to this build only when this build made
// it (its workspace.json names it). Otherwise it is another prototype
// with the same slug, and writing into it would destroy that prototype.
const recordPath = join(buildDir, "workspace.json");
const ours = existsSync(recordPath) && JSON.parse(readFileSync(recordPath, "utf8")).path === workspace;
if (!fresh && !ours) fail(`a prototype named ${slug} already exists in ${workspaces}: choose another slug`);
mkdirSync(workspaces, { recursive: true });
if (fresh) {
  cpSync(template, workspace, { recursive: true, filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source) });
} else {
  // Files the template has and the workspace lost come back; nothing the workspace has is touched.
  cpSync(template, workspace, { recursive: true, force: false, filter: (source) => !/[\\/](node_modules|dist)([\\/]|$)/.test(source) });
}

// ---- names and port ----
const title = options.title ?? slug;
const port = fresh ? await pickPort(workspaces, slug) : JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8")).port;
editJson(join(workspace, "package.json"), (pkg) => ({ ...pkg, name: slug }));
editJson(join(workspace, "public", "prototype.json"), (manifest) => ({ ...manifest, name: slug, port }));
edit(join(workspace, "index.html"), (html) => html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`));
edit(join(workspace, "vite.config.ts"), (source) => source.replace(/port: \d+,/, `port: ${port},`));

// ---- the rig's source paths, until it publishes to npm ----
const adapter = framework === "vue" ? ["@proto/rig-vue", `${packages}/rig-vue/src/index.ts`] : ["@proto/rig", `${packages}/rig/src/index.tsx`];
editJson(join(workspace, "tsconfig.json"), (tsconfig) => ({
  ...tsconfig,
  compilerOptions: {
    ...tsconfig.compilerOptions,
    paths: {
      [adapter[0]]: [adapter[1]],
      "@proto/rig-core": [`${packages}/rig-core/src/index.ts`],
      "@proto/wire": [`${packages}/wire/src/index.ts`],
    },
  },
}));

// ---- the page's tokens, fonts and face ----
const src = join(workspace, "src");
const tokens = read.page.tokens;
const tokenLines = (vars) => Object.entries(vars).map(([name, value]) => `  ${name}: ${value};`).join("\n");
writeFileSync(
  join(src, "tokens.css"),
  `/* The reference page's custom properties, as computed on :root and body\n   (${read.page.url.split("?")[0]}), read by tools/build-stream.mjs. */\n:root {\n${tokenLines(tokens.root)}\n}\n${Object.keys(tokens.body).length ? `\nbody {\n${tokenLines(tokens.body)}\n}\n` : ""}`,
);
const fontsDir = join(src, "fonts");
mkdirSync(fontsDir, { recursive: true });
const faces = [];
for (const face of read.faces ?? []) {
  let body = face.body;
  let complete = true;
  for (const match of face.body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (match[1].startsWith("data:")) continue;
    const absolute = new URL(match[1], face.base ?? read.page.url).toString();
    const file = face.files?.[absolute];
    if (!file || !existsSync(file)) {
      complete = false;
      break;
    }
    copyFileSync(file, join(fontsDir, basename(file)));
    body = body.replace(match[0], `url("./fonts/${basename(file)}")`);
  }
  if (complete) faces.push(`@font-face {\n  ${body.trim().replace(/;\s*/g, ";\n  ").replace(/\n  $/, "")}\n}\n`);
}
writeFileSync(join(src, "fonts.css"), `/* The reference page's @font-face rules, with its font files beside them. */\n${faces.join("\n")}`);

const bodyStyle = read.page.body;
const stylesPath = join(src, "styles.css");
if (fresh || !readFileSync(stylesPath, "utf8").includes("tokens.css")) {
  const imports = [tailwind ? '@import "tailwindcss";' : null, '@import "./tokens.css";', '@import "./fonts.css";'].filter(Boolean).join("\n");
  const html = read.page.html;
  writeFileSync(
    stylesPath,
    `${imports}

/* The reference page's own base, as computed on html and body; every
   part states what differs from this. */
* { box-sizing: border-box; margin: 0; }
html {
  font-size: ${html.fontSize};
  color-scheme: ${html.colorScheme};
  background-color: ${html.backgroundColor};
}
body {
  background-color: ${bodyStyle["background-color"]};
  color: ${bodyStyle.color};
  font-family: ${bodyStyle["font-family"]};
  font-size: ${bodyStyle["font-size"]};
  font-weight: ${bodyStyle["font-weight"]};
  line-height: ${bodyStyle["line-height"]};
  letter-spacing: ${bodyStyle["letter-spacing"]};
  -webkit-font-smoothing: ${bodyStyle["-webkit-font-smoothing"]};
  text-rendering: ${bodyStyle["text-rendering"]};
}
`,
  );
}

// ---- Tailwind, when the source uses it ----
if (tailwind) {
  edit(join(workspace, "vite.config.ts"), (source) => {
    if (source.includes("@tailwindcss/vite")) return source;
    return source
      .replace('import react from "@vitejs/plugin-react";', 'import react from "@vitejs/plugin-react";\nimport tailwindcss from "@tailwindcss/vite";')
      .replace("plugins: [react()],", "plugins: [react(), tailwindcss()],");
  });
}

// ---- install, from the shared store ----
let install = 0;
const lock = join(workspace, "pnpm-lock.yaml");
const stamp = join(workspace, "node_modules", ".proto-lock");
const lockText = existsSync(lock) ? readFileSync(lock, "utf8") : "";
const installed = existsSync(join(workspace, "node_modules")) && existsSync(stamp) && readFileSync(stamp, "utf8") === lockText;
if (!installed) {
  const began = Date.now();
  const result = spawnSync("pnpm", ["install", "--prefer-offline", ...(lockText ? ["--frozen-lockfile"] : [])], { cwd: workspace, encoding: "utf8" });
  if (result.status !== 0) fail(`pnpm install failed in ${workspace}:\n${result.stderr}`);
  writeFileSync(stamp, lockText);
  install = Math.round((Date.now() - began) / 100) / 10;
}

// ---- the record the build reads ----
const record = { slug, path: workspace, port, framework, tailwind, title };
writeFileSync(join(buildDir, "workspace.json"), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify({ ...record, seconds: Math.round((Date.now() - started) / 100) / 10, install }));

function usesTailwind(path, deps) {
  if ("tailwindcss" in deps) return true;
  // A monorepo names it in a package, not at the root: the lockfile knows.
  for (const name of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    try {
      if (readFileSync(join(path, name), "utf8").includes("tailwindcss@")) return true;
    } catch {}
  }
  return false;
}

/**
 * The lowest port from 5200 that no workspace of this codebase claims
 * in its prototype.json and nothing on this laptop is bound to.
 */
async function pickPort(root, own) {
  const claimed = new Set();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === own) continue;
    try {
      claimed.add(JSON.parse(readFileSync(join(root, entry.name, "public", "prototype.json"), "utf8")).port);
    } catch {}
  }
  for (let port = 5200; port < 5400; port++) {
    if (claimed.has(port)) continue;
    if (await free(port)) return port;
  }
  fail("no free port between 5200 and 5400");
}

function free(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function edit(path, change) {
  writeFileSync(path, change(readFileSync(path, "utf8")));
}

function editJson(path, change) {
  writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf8"))), null, 2) + "\n");
}

function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
