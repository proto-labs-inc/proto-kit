import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("setup action helper sends typed blockers, defaults old callers to other, and clears explicitly", t => {
  const dir = mkdtempSync(join(tmpdir(), "setup-action-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "setup-action.mjs"), readFileSync(new URL("./setup-action.mjs", import.meta.url)));
  writeFileSync(join(dir, "mcp-call.mjs"), 'export async function callTool(name, input) { return {content:[{text:JSON.stringify({name,input})}]}; }');
  for (const kind of ["product-url", "sign-in", "approval", "other", undefined]) {
    const args = [join(dir, "setup-action.mjs"), "fixture", "Please continue"];
    if (kind) args.push(kind);
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {name:"report_setup_action",input:{codebase:"fixture",action:{kind:kind ?? "other",message:"Please continue"}}});
  }
  const clear = spawnSync(process.execPath, [join(dir,"setup-action.mjs"),"fixture","clear"], {encoding:"utf8"});
  assert.equal(JSON.parse(clear.stdout).input.action, null);
  const invalid = spawnSync(process.execPath, [join(dir,"setup-action.mjs"),"fixture","Message","bad-kind"], {encoding:"utf8"});
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
});
