import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLegacyCourierRun } from "./legacy-runs.mjs";
import { kitScript, repairProcesses, restartRun } from "./run-repair.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "serving-repair-"));
  const kit = join(root, "kit"), runDir = join(root, "run", "library");
  mkdirSync(join(kit, "tools"), { recursive: true }); mkdirSync(runDir, { recursive: true });
  writeFileSync(join(kit, "tools", "serve.mjs"), "");
  return { root, kit, runDir };
}
test("serving repair repoints available tools and removes obsolete env", () => {
  const { kit, runDir } = fixture();
  const spec = { processes: [{ name: "dev", command: ["node", "/old/tools/serve.mjs"], env: { PROTO_PACKAGES: "/old", KEEP: "yes" } }] };
  const result = repairProcesses({ name: "library", spec, kit, runDir });
  assert.equal(result.processes[0].command[1], join(kit, "tools", "serve.mjs"));
  assert.deepEqual(result.processes[0].env, { KEEP: "yes" });
  assert.equal(spec.processes[0].env.PROTO_PACKAGES, "/old");
  assert.equal(kitScript("/old/tools/removed.mjs", kit), null);
});
test("serving repair removes the tunnel and the heartbeat, token and public-host setting included", () => {
  const { kit, runDir } = fixture();
  const spec = { processes: [
    { name: "dev", command: ["pnpm", "dev"], env: { PROTO_TUNNEL: "1", PROTO_PORT: "5210" } },
    { name: "tunnel", command: ["cloudflared", "tunnel", "run", "--token", "secret"] },
    { name: "heartbeat", command: ["node", "/old/tools/prototype-heartbeat.mjs"] },
  ] };
  const result = repairProcesses({ name: "library", spec, kit, runDir });
  assert.deepEqual(result.processes, [{ name: "dev", command: ["pnpm", "dev"], env: { PROTO_PORT: "5210" } }]);
  assert.deepEqual(result.changes, [{ kind: "drop-tunnel", names: ["tunnel", "heartbeat", "dev"] }]);
});
test("legacy specs cannot be repaired or restarted under any name", () => {
  const { kit, runDir } = fixture();
  const spec = { name: "fixture/courier", processes: [{ name: "listener", command: ["node", "/old/tools/courier.mjs", runDir] }] };
  writeFileSync(join(runDir, "spec.json"), JSON.stringify(spec));
  assert.equal(isLegacyCourierRun(runDir), true);
  const result = repairProcesses({ name: "renamed", spec, kit, runDir });
  assert.equal(result.retired, true);
  assert.deepEqual(result.processes, spec.processes);
  assert.deepEqual(result.changes, []);
  assert.equal(restartRun(runDir, kit), false);
});
