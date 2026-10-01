#!/usr/bin/env node
/** Synchronize the separately installed Codex roles and MCP bridge.
 * Run from the installed kit after `codex plugin add`. This never updates
 * marketplaces, starts services, reads Proto credentials, or repairs runs.
 * Usage: node tools/codex-install.mjs [--check]
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runCodex = (args) => execFileSync("codex", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function syncCodexInstallation({
  kit,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  check = false,
  run = runCodex,
}) {
  const source = join(kit, "codex-agents");
  const destination = join(codexHome, "agents");
  const changedRoles = readdirSync(source).filter((name) => name.endsWith(".toml")).filter((name) => {
    const target = join(destination, name);
    if (existsSync(target) && !lstatSync(target).isFile()) throw new Error(`Refusing to replace a non-file role: ${target}`);
    return !existsSync(target) || !readFileSync(target).equals(readFileSync(join(source, name)));
  });
  const obsolete = join(destination, "proto-listen.toml");
  const retire = existsSync(obsolete);
  if (retire && (!lstatSync(obsolete).isFile() || !/^name\s*=\s*"proto-listen"/m.test(readFileSync(obsolete, "utf8")) || !/proto listen skill/i.test(readFileSync(obsolete, "utf8")))) {
    throw new Error("The installed proto-listen role is not recognizable as Proto's role; leave it intact for review.");
  }

  let previous;
  try {
    previous = JSON.parse(run(["mcp", "get", "proto", "--json"]));
  } catch (error) {
    if (!/No MCP server (named|found)|not found/i.test(String(error.stderr ?? error.message))) throw error;
    previous = null;
  }
  const bridge = join(kit, "tools", "mcp-stdio.mjs");
  if (!existsSync(bridge)) throw new Error(`The installed kit has no MCP bridge: ${bridge}`);
  const bridgeMatches = (entry) => entry?.transport?.type === "stdio" && entry.transport.command === "node" && entry.transport.args?.length === 1 && entry.transport.args[0] === bridge;
  const updateBridge = !bridgeMatches(previous);
  // `mcp add` replaces a server entry. Do not silently discard custom settings.
  if (updateBridge && previous && (
    previous.transport?.type !== "stdio" ||
    Object.keys(previous.transport.env ?? {}).length > 0 ||
    (previous.transport.env_vars?.length ?? 0) > 0 || previous.transport.cwd ||
    previous.enabled === false || previous.enabled_tools || previous.disabled_tools ||
    previous.startup_timeout_sec != null || previous.tool_timeout_sec != null
  )) throw new Error("The Proto MCP entry has custom settings; preserve them when updating its bridge path.");

  let backupDir = null;
  const backup = (file, move = false) => {
    if (!backupDir) {
      const root = join(codexHome, "agents-archive", "proto");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      backupDir = mkdtempSync(join(root, "sync-"));
    }
    const target = join(backupDir, file.slice(file.lastIndexOf("/") + 1));
    if (move) renameSync(file, target);
    else copyFileSync(file, target);
  };

  if (!check) {
    if (updateBridge) {
      run(["mcp", "add", "proto", "--", "node", bridge]);
      if (!bridgeMatches(JSON.parse(run(["mcp", "get", "proto", "--json"])))) throw new Error("Codex did not confirm the new Proto MCP bridge path.");
    }
    if (changedRoles.length) mkdirSync(destination, { recursive: true });
    for (const name of changedRoles) {
      const target = join(destination, name);
      if (existsSync(target)) backup(target);
      copyFileSync(join(source, name), target);
      if (!readFileSync(target).equals(readFileSync(join(source, name)))) throw new Error(`Role did not match after installation: ${name}`);
    }
    if (retire) backup(obsolete, true);
  }
  return { kit, check, changedRoles, retiredRoles: retire ? ["proto-listen.toml"] : [], bridge, bridgeChanged: updateBridge, backupDir };
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--check");
    if (unknown.length) throw new Error("usage: node tools/codex-install.mjs [--check]");
    console.log(JSON.stringify(syncCodexInstallation({ kit: dirname(dirname(fileURLToPath(import.meta.url))), check: process.argv.includes("--check") })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
