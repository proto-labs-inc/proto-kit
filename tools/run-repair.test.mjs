import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { courierHarness, describeChange, kitScript, repairProcesses } from "./run-repair.mjs";

// A throwaway kit carrying the tools the specs below name, and a run dir.
function fixture(courierJson = null) {
  const root = mkdtempSync(join(tmpdir(), "run-repair-"));
  const kit = join(root, "kit");
  mkdirSync(join(kit, "tools"), { recursive: true });
  for (const tool of ["courier.mjs", "feed-queue.mjs", "prototype-heartbeat.mjs"]) writeFileSync(join(kit, "tools", tool), "");
  const runDir = join(root, "run", "courier");
  mkdirSync(runDir, { recursive: true });
  if (courierJson) writeFileSync(join(runDir, "courier.json"), JSON.stringify(courierJson));
  return { kit, runDir };
}

const pastTense = (_verb, done) => done;

test("a pre-relay courier loses its tunnel and is pointed at this kit", () => {
  const { kit, runDir } = fixture();
  const spec = {
    processes: [
      { name: "listener", command: ["node", "/old/kit/tools/courier.mjs", runDir] },
      { name: "tunnel", command: ["cloudflared", "tunnel", "run", "--token", "t"] },
    ],
  };
  const repair = repairProcesses({ name: "courier", spec, kit, runDir, harness: "claude" });
  assert.deepEqual(
    repair.processes.map((p) => p.name),
    ["listener"],
  );
  assert.equal(repair.processes[0].command[1], join(kit, "tools", "courier.mjs"));
  assert.equal(repair.missing, true);
  assert.deepEqual(
    repair.changes.map((c) => describeChange(c, pastTense)),
    ["removed the courier's tunnel, which the relay replaces", "pointed listener at this copy of the kit, whose own copy is gone"],
  );
  assert.equal(spec.processes.length, 2, "the spec passed in is left as it was");
});

test("a courier already in this kit's shape needs nothing", () => {
  const { kit, runDir } = fixture();
  const spec = { processes: [{ name: "listener", command: ["node", join(kit, "tools", "courier.mjs"), runDir] }] };
  const repair = repairProcesses({ name: "courier", spec, kit, runDir, harness: "claude" });
  assert.deepEqual(repair.changes, []);
  assert.equal(repair.missing, false);
});

test("the Codex wake is added on Codex and removed elsewhere", () => {
  const { kit, runDir } = fixture();
  const bare = { processes: [{ name: "listener", command: ["node", join(kit, "tools", "courier.mjs"), runDir] }] };
  const added = repairProcesses({ name: "courier", spec: bare, kit, runDir, harness: "codex" });
  assert.deepEqual(added.processes.map((p) => p.name), ["listener", "codex-wake"]);
  assert.deepEqual(added.changes, [{ kind: "add-wake" }]);

  const removed = repairProcesses({ name: "courier", spec: { processes: added.processes }, kit, runDir, harness: "claude" });
  assert.deepEqual(removed.processes.map((p) => p.name), ["listener"]);
  assert.deepEqual(removed.changes, [{ kind: "remove-wake" }]);
});

test("a courier whose harness nobody can tell is left its wake question, not guessed", () => {
  const { kit, runDir } = fixture();
  const spec = { processes: [{ name: "listener", command: ["node", join(kit, "tools", "courier.mjs"), runDir] }] };
  const repair = repairProcesses({ name: "courier", spec, kit, runDir, harness: null });
  assert.equal(repair.unsure, true);
  assert.deepEqual(repair.changes, []);
});

test("rule 1 is the courier's only: a prototype's tunnel stays", () => {
  const { kit, runDir } = fixture();
  const spec = {
    processes: [
      { name: "dev", command: ["pnpm", "dev"] },
      { name: "tunnel", command: ["cloudflared", "tunnel", "run", "--token", "t"] },
    ],
  };
  const repair = repairProcesses({ name: "some-prototype", spec, kit, runDir, harness: null });
  assert.deepEqual(repair.changes, []);
  assert.deepEqual(repair.processes.map((p) => p.name), ["dev", "tunnel"]);
});

test("kitScript points only at tools this kit carries", () => {
  const { kit } = fixture();
  assert.equal(kitScript("/elsewhere/tools/feed-queue.mjs", kit), join(kit, "tools", "feed-queue.mjs"));
  assert.equal(kitScript("/elsewhere/tools/dropped.mjs", kit), null);
  assert.equal(kitScript("cloudflared", kit), null);
});

test("courierHarness reads the courier's own files before the caller's word", () => {
  const { runDir } = fixture({ codexThread: { id: "x" } });
  const spec = { processes: [] };
  assert.equal(courierHarness(runDir, spec, "claude"), "codex");
  const plain = fixture();
  assert.equal(courierHarness(plain.runDir, spec, "cursor"), "cursor");
  assert.equal(courierHarness(plain.runDir, spec), null);
});
