import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createReporter } from "./build-report.mjs";
import { workflowEvent } from "./workflow-report.mjs";

test("unacknowledged progress survives reporter restart with the same report identity", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proto-report-"));
  try {
    const heard = [];
    const offline = createReporter({codebase:"test", briefId:"test", runDir:dir, transport:async (_tool, args) => { heard.push(args.events); throw new Error("offline"); }});
    offline.send([workflowEvent(dir, "review", "Reviewing the request")]);
    assert.equal(readdirSync(join(dir,"outbox")).filter(x=>x.endsWith(".json")).length, 1);
    await assert.rejects(offline.flush(), /offline/);
    const online = createReporter({codebase:"test", briefId:"test", runDir:dir, transport:async (_tool, args) => { heard.push(args.events); return {content:[]}; }});
    await online.flush();
    assert.deepEqual(heard[0], heard[1]);
    assert.equal(readdirSync(join(dir,"outbox")).length, 0);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
test("fixing after a check advances the revision while check and publish retain it", () => {
  const dir=mkdtempSync(join(tmpdir(),"proto-workflow-"));
  try {
    const build=workflowEvent(dir,"build","Build");
    assert.equal(workflowEvent(dir,"check","Check").revision,build.revision);
    const fix=workflowEvent(dir,"build","Fix");
    assert.notEqual(fix.revision,build.revision);
    assert.equal(workflowEvent(dir,"publish","Publish").revision,fix.revision);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
