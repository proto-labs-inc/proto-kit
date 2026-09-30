#!/usr/bin/env node
/**
 * Move this laptop's prototype workspaces onto the rig from npm, once.
 * The update skill runs it after the plugin updates.
 *
 * A workspace scaffolded before the rig was published imports
 * `@proto/rig` (or `@proto/rig-vue`) and `@proto/wire`, and resolves
 * them from a proto checkout's source: vite aliases fed by
 * PROTO_PACKAGES, tsconfig paths to the checkout. This rewrites each
 * such workspace to what scaffold.mjs writes now:
 *
 *   1. package.json depends on the adapter and the wire at the version
 *      this kit's template pins, and `pnpm install` fetches them;
 *   2. every import in src/ names `@proto-labs-inc/…`;
 *   3. tsconfig.json loses its `@proto/…` paths;
 *   4. vite.config.ts loses the PROTO_PACKAGES block and its aliases.
 *
 * The install runs first. When it fails, package.json goes back to
 * what it was and nothing else in that workspace is touched, so a dev
 * server that is up keeps serving. A dev server that is up picks the
 * rest up by itself: vite restarts when its config changes.
 *
 * Everything the prototype is made of stays: only the lines above
 * change. A vite.config.ts in a shape this does not recognise is left
 * as it was and named in the report, for a hand edit.
 *
 * Usage: node migrate-rig.mjs [<codebase>…] [--check]
 *   --check   say what would change, change nothing
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OLD_IMPORT = /(["'])@proto\/(rig-core|rig-vue|rig|wire)\1/g;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mts|mjs|vue)$/;

/** The dependencies a workspace of this framework takes, from this kit's template. */
export function rigDependencies(kit, framework) {
  const template = JSON.parse(readFileSync(join(kit, "template", `workspace-${framework}`, "package.json"), "utf8"));
  return Object.fromEntries(Object.entries(template.dependencies).filter(([name]) => name.startsWith("@proto-labs-inc/")));
}

/** Source text with every `@proto/…` import renamed; unchanged when there is none. */
export function renameImports(source) {
  return source.replace(OLD_IMPORT, (_match, quote, name) => `${quote}@proto-labs-inc/${name}${quote}`);
}

/** tsconfig.json without its `@proto/…` paths, or null when it has none. */
export function withoutRigPaths(tsconfig) {
  const paths = tsconfig.compilerOptions?.paths;
  if (!paths || !Object.keys(paths).some((key) => key.startsWith("@proto/"))) return null;
  const kept = Object.fromEntries(Object.entries(paths).filter(([key]) => !key.startsWith("@proto/")));
  const compilerOptions = { ...tsconfig.compilerOptions, paths: kept };
  if (Object.keys(kept).length === 0) delete compilerOptions.paths;
  return { ...tsconfig, compilerOptions };
}

/**
 * vite.config.ts without the rig's source resolution. Returns
 * { kind: "unchanged" } when it has none, { kind: "rewritten", text }
 * when it did, and { kind: "unknown" } when PROTO_PACKAGES or an
 * `@proto/` alias survives the known shapes.
 */
export function withoutSourceRig(text) {
  if (!/PROTO_PACKAGES|@proto\//.test(text)) return { kind: "unchanged" };
  let lines = text.split("\n");

  // The explanation above `const packages`, and the line itself.
  const note = lines.findIndex((line) => line.startsWith("// Pre-npm: the rig ships as source."));
  const declared = lines.findIndex((line) => /^const packages = .*PROTO_PACKAGES/.test(line));
  if (declared === -1) return { kind: "unknown" };
  const from = note !== -1 && note < declared ? note : declared;
  lines.splice(from, declared - from + 1);

  // The dedupe the source-aliased rig needed, with its explanation.
  const dedupeNote = lines.findIndex((line) => line.trim() === "// The source-aliased rig resolves from outside this standalone");
  if (dedupeNote !== -1 && lines[dedupeNote + 3]?.trim().startsWith("dedupe:")) lines.splice(dedupeNote, 4);

  // The aliases: the rig's own, and the modern-screenshot pin with its note.
  lines = lines.filter((line) => !/^\s*"@proto\/[a-z-]+": /.test(line));
  const pinNote = lines.findIndex((line) => line.trim() === "// The rig lazy-imports this from the prototype's own deps; with the");
  if (pinNote !== -1) lines.splice(pinNote, 2);
  const pin = lines.findIndex((line) => /^\s*"modern-screenshot": fileURLToPath\($/.test(line));
  if (pin !== -1 && /^\s*\),$/.test(lines[pin + 2] ?? "")) lines.splice(pin, 3);

  // `...(packages && { … }),` becomes its contents, one level out.
  const opened = lines.findIndex((line) => /^\s*\.\.\.\(packages && \{$/.test(line));
  if (opened !== -1) {
    const indent = lines[opened].match(/^\s*/)[0];
    const closed = lines.findIndex((line, i) => i > opened && line === `${indent}}),`);
    if (closed === -1) return { kind: "unknown" };
    const inner = lines.slice(opened + 1, closed).map((line) => (line.startsWith(`${indent}  `) ? line.slice(2) : line));
    lines.splice(opened, closed - opened + 1, ...inner);
  }

  // Whatever is now empty goes: an alias map, then a resolve block.
  let result = lines.join("\n");
  result = result.replace(/\n\s*alias: \{\s*\},/, "");
  result = result.replace(/\n\s*resolve: \{\s*\},/, "");

  // Imports only the removed lines used.
  if (!/fileURLToPath\(/.test(result)) result = result.replace(/import \{ fileURLToPath \} from "node:url";\n/, "");
  if (!/loadEnv\(/.test(result)) result = result.replace(/import \{ defineConfig, loadEnv \} from "vite";/, 'import { defineConfig } from "vite";');

  if (/PROTO_PACKAGES|@proto\/|\bpackages\b/.test(result)) return { kind: "unknown" };
  return { kind: "rewritten", text: result };
}

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (SOURCE_FILE.test(entry.name)) found.push(path);
  }
  return found;
}

/**
 * What one workspace needs, read without writing anything: the
 * dependencies to add, the source files to rename, the new tsconfig and
 * vite config. `needed` is false for a workspace already on npm.
 */
export function planWorkspace(workspace, kit) {
  const packagePath = join(workspace, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = "vue" in deps ? "vue" : "react";
  const wanted = rigDependencies(kit, framework);
  const missing = Object.fromEntries(Object.entries(wanted).filter(([name]) => !(name in deps)));

  const src = join(workspace, "src");
  const renames = existsSync(src)
    ? sourceFiles(src).flatMap((path) => {
        const before = readFileSync(path, "utf8");
        const after = renameImports(before);
        return after === before ? [] : [{ path, text: after }];
      })
    : [];

  const tsconfigPath = join(workspace, "tsconfig.json");
  const tsconfig = existsSync(tsconfigPath) ? withoutRigPaths(JSON.parse(readFileSync(tsconfigPath, "utf8"))) : null;

  const vitePath = join(workspace, "vite.config.ts");
  const vite = existsSync(vitePath) ? withoutSourceRig(readFileSync(vitePath, "utf8")) : { kind: "unchanged" };

  const needed = Object.keys(missing).length > 0 || renames.length > 0 || tsconfig !== null || vite.kind !== "unchanged";
  return { needed, pkg, packagePath, missing, renames, tsconfigPath, tsconfig, vitePath, vite };
}

/** Apply a plan: install first, then rewrite. Returns what happened, in words. */
export function applyPlan(workspace, plan) {
  const originalPackage = readFileSync(plan.packagePath, "utf8");
  if (Object.keys(plan.missing).length > 0) {
    const pkg = { ...plan.pkg, dependencies: { ...plan.pkg.dependencies, ...plan.missing } };
    writeFileSync(plan.packagePath, JSON.stringify(pkg, null, 2) + "\n");
  }
  const install = spawnSync("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], { cwd: workspace, encoding: "utf8" });
  if (install.status !== 0) {
    writeFileSync(plan.packagePath, originalPackage);
    const reason = (install.stderr || install.stdout || "").trim().split("\n").slice(-3).join(" ");
    return { kind: "failed", reason };
  }
  for (const { path, text } of plan.renames) writeFileSync(path, text);
  if (plan.tsconfig) writeFileSync(plan.tsconfigPath, JSON.stringify(plan.tsconfig, null, 2) + "\n");
  if (plan.vite.kind === "rewritten") writeFileSync(plan.vitePath, plan.vite.text);
  return { kind: "done" };
}

function describe(plan, did) {
  const parts = [];
  const added = Object.entries(plan.missing).map(([name, version]) => `${name}@${version}`);
  if (added.length > 0) parts.push(`${did("add", "added")} ${added.join(" and ")}`);
  if (plan.renames.length > 0) parts.push(`${did("rename", "renamed")} the rig's imports in ${plan.renames.length} file${plan.renames.length === 1 ? "" : "s"}`);
  if (plan.tsconfig) parts.push(`${did("drop", "dropped")} the rig's source paths from tsconfig.json`);
  if (plan.vite.kind === "rewritten") parts.push(`${did("drop", "dropped")} PROTO_PACKAGES and the rig's aliases from vite.config.ts`);
  return parts.join(", ");
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes("--check");
  const named = argv.filter((arg) => !arg.startsWith("--"));
  const did = (verb, past) => (check ? `would ${verb}` : past);
  const kit = dirname(dirname(fileURLToPath(import.meta.url)));
  const root = join(process.env.HOME ?? "", ".proto");
  const dirs = (path) => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  };

  const codebases = named.length > 0 ? named : dirs(root).filter((name) => !name.startsWith("chrome"));
  const lines = [];
  for (const codebase of codebases) {
    const prototypes = join(root, codebase, "prototypes");
    for (const slug of dirs(prototypes)) {
      const workspace = join(prototypes, slug);
      if (!existsSync(join(workspace, "package.json"))) continue;
      const plan = planWorkspace(workspace, kit);
      if (!plan.needed) continue;
      const label = `${codebase}/${slug}`;
      const unknown = plan.vite.kind === "unknown" ? " Its vite.config.ts still reads PROTO_PACKAGES in a shape this does not recognise; remove that by hand." : "";
      if (check) {
        lines.push(`${label}: ${describe(plan, did)}.${unknown}`);
        continue;
      }
      const outcome = applyPlan(workspace, plan);
      if (outcome.kind === "failed") lines.push(`${label}: pnpm install failed, so nothing changed there (${outcome.reason}).`);
      else lines.push(`${label}: ${describe(plan, did)}.${unknown}`);
    }
  }
  if (lines.length === 0) console.log("Every prototype already takes the rig from npm; nothing needed moving.");
  for (const line of lines) console.log(line);
  if (check && lines.length > 0) console.log("\nNothing was written (--check).");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
