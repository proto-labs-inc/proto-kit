import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { syncCodexInstallation } from "./codex-install.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "proto-codex-install-"));
  const kit = join(dir, "kit");
  const codexHome = join(dir, "codex");
  mkdirSync(join(kit, "codex-agents"), { recursive: true });
  mkdirSync(join(kit, "tools"));
  mkdirSync(join(codexHome, "agents"), { recursive: true });
  writeFileSync(join(kit, "tools", "mcp-stdio.mjs"), "// fixture\n");
  writeFileSync(join(kit, "codex-agents", "proto-builder.toml"), 'name = "proto-builder"\n');
  writeFileSync(join(codexHome, "agents", "proto-builder.toml"), "old role\n");
  writeFileSync(join(codexHome, "agents", "proto-listen.toml"), '# The proto listen skill\nname = "proto-listen"\n');
  writeFileSync(join(codexHome, "agents", "personal.toml"), "personal\n");
  let entry = { transport: { type: "stdio", command: "node", args: ["/old/tools/mcp-stdio.mjs"] } };
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[1] === "get") return JSON.stringify(entry);
    assert.deepEqual(args.slice(0, 5), ["mcp", "add", "proto", "--", "node"]);
    entry = { transport: { type: "stdio", command: "node", args: [args[5]] } };
    return "added";
  };
  return { kit, codexHome, run, calls, getEntry: () => entry };
}

test("sync updates supported roles and bridge, archives the obsolete role, and is idempotent", () => {
  const f = fixture();
  const result = syncCodexInstallation(f);
  assert.deepEqual(result.changedRoles, ["proto-builder.toml"]);
  assert.deepEqual(result.retiredRoles, ["proto-listen.toml"]);
  assert.equal(readFileSync(join(result.backupDir, "proto-builder.toml"), "utf8"), "old role\n");
  assert.equal(existsSync(join(result.backupDir, "proto-listen.toml")), true);
  assert.equal(existsSync(join(f.codexHome, "agents", "proto-listen.toml")), false);
  assert.equal(readFileSync(join(f.codexHome, "agents", "personal.toml"), "utf8"), "personal\n");
  assert.equal(f.getEntry().transport.args[0], join(f.kit, "tools", "mcp-stdio.mjs"));
  const again = syncCodexInstallation(f);
  assert.deepEqual(again.changedRoles, []);
  assert.deepEqual(again.retiredRoles, []);
  assert.equal(again.bridgeChanged, false);
  assert.equal(again.backupDir, null);
  assert.equal(f.calls.filter((args) => args[1] === "add").length, 1);
});

test("check reports changes without writing roles or updating MCP", () => {
  const f = fixture();
  const result = syncCodexInstallation({ ...f, check: true });
  assert.equal(result.bridgeChanged, true);
  assert.equal(readFileSync(join(f.codexHome, "agents", "proto-builder.toml"), "utf8"), "old role\n");
  assert.equal(existsSync(join(f.codexHome, "agents", "proto-listen.toml")), true);
  assert.equal(existsSync(join(f.codexHome, "agents-archive")), false);
  assert.equal(f.calls.some((args) => args[1] === "add"), false);
});

test("an unfamiliar listener role is preserved before any mutation", () => {
  const f = fixture();
  writeFileSync(join(f.codexHome, "agents", "proto-listen.toml"), "my custom role\n");
  assert.throws(() => syncCodexInstallation(f), /not recognizable/);
  assert.equal(f.calls.length, 0);
  assert.equal(readFileSync(join(f.codexHome, "agents", "proto-listen.toml"), "utf8"), "my custom role\n");
});

test("custom MCP settings are preserved rather than replaced", () => {
  const f = fixture();
  const run = (args) => {
    assert.equal(args[1], "get");
    return JSON.stringify({ ...f.getEntry(), disabled_tools: ["example"] });
  };
  assert.throws(() => syncCodexInstallation({ ...f, run }), /custom settings/);
  assert.equal(existsSync(join(f.codexHome, "agents", "proto-listen.toml")), true);
});
