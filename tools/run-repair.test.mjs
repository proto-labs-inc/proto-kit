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
  writeFileSync(join(kit, "tools", "heartbeat.mjs"), "");
  return { root, kit, runDir };
}
test("serving repair keeps tunnels, repoints available tools and removes obsolete env", () => {
  const { kit, runDir } = fixture();
  const spec = { processes: [{ name: "heartbeat", command: ["node", "/old/tools/heartbeat.mjs"], env: { PROTO_PACKAGES: "/old", KEEP: "yes" } }, { name: "tunnel", command: ["cloudflared", "tunnel", "run"] }] };
  const result = repairProcesses({ name: "library", spec, kit, runDir });
  assert.equal(result.processes[0].command[1], join(kit, "tools", "heartbeat.mjs"));
  assert.deepEqual(result.processes[0].env, { KEEP: "yes" });
  assert.deepEqual(result.processes[1], spec.processes[1]);
  assert.equal(spec.processes[0].env.PROTO_PACKAGES, "/old");
  assert.equal(kitScript("/old/tools/removed.mjs", kit), null);
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
