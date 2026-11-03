import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";

/** Use the customer's lockfile and script runner, never the Kit's package manager. */
export function applicationPackageManager(worktree) {
  let manager;
  if (existsSync(join(worktree, "pnpm-lock.yaml"))) manager = "pnpm";
  else if (existsSync(join(worktree, "package-lock.json"))) manager = "npm";
  else if (existsSync(join(worktree, "yarn.lock"))) manager = "yarn";
  else if (existsSync(join(worktree, "bun.lock")) || existsSync(join(worktree, "bun.lockb"))) manager = "bun";
  else {
    const pkg = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"));
    manager = pkg.packageManager?.split("@")[0];
  }
  if (!["pnpm", "npm", "yarn", "bun"].includes(manager)) throw new Error("Connect an app with a supported package manager and lockfile.");
  const commands = {
    pnpm: { install: ["install", "--frozen-lockfile"], build: ["build"], dev: port => ["dev", "--port", String(port)] },
    npm: { install: ["ci"], build: ["run", "build"], dev: port => ["run", "dev", "--", "--port", String(port)] },
    yarn: { install: ["install", "--immutable"], build: ["build"], dev: port => ["dev", "--port", String(port)] },
    bun: { install: ["install", "--frozen-lockfile"], build: ["run", "build"], dev: port => ["run", "dev", "--", "--port", String(port)] },
  };
  return { bin: manager, ...commands[manager] };
}

export function installApplicationDependencies(worktree, appRoot, run = execFileSync) {
  if (existsSync(join(appRoot, "node_modules")) || existsSync(join(worktree, "node_modules"))) return;
  const manager = applicationPackageManager(worktree);
  run(manager.bin, manager.install, { cwd: worktree, stdio: "inherit" });
}

/** External JSX resolves the customer's React instance and types through the
 * same dependency tree as the app. The link is outside every immutable bundle. */
export function ensureAlternateDependencies(record) {
  const app = join(record.worktree, record.appRoot);
  const target = existsSync(join(app, "node_modules")) ? join(app, "node_modules") : join(record.worktree, "node_modules");
  if (!existsSync(target)) throw new Error("Install the customer application's dependencies before saving alternates.");
  mkdirSync(record.alternateStorage, { recursive: true });
  const link = join(record.alternateStorage, "node_modules");
  try {
    const entry = lstatSync(link);
    if (!entry.isSymbolicLink() || realpathSync(link) !== realpathSync(target)) throw new Error("Alternate dependency link points at another package tree.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    symlinkSync(target, link, "dir");
  }
  return link;
}
