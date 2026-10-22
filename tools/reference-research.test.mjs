import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { research, saveSelected } from "./reference-research.mjs";
const envelope = data => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
test("interrupted research resumes its run and never issues a second start", async () => {
 const workspace = mkdtempSync(join(tmpdir(), "research-")); let starts = 0; let advances = 0;
 const call = async (_name, args) => { if(args.operation === "start") starts++; if(args.operation === "advance") advances++; return envelope({ id: "run", stage: "score", status: advances > 1 ? "completed" : "running", terminal: advances > 1, counts: { candidates: 3, scored: advances }, references: [] }); };
 try { await research(workspace, { codebase: "code" }, { call, maxSteps: 1, log() {} }); await research(workspace, { codebase: "code" }, { call, maxSteps: 1, log() {} }); assert.equal(starts, 1); assert.equal(advances, 2); } finally { rmSync(workspace, { recursive: true, force: true }); }
});
test("downloads use authenticated Proto paths and reject HTML or credential redirects", async () => {
 const workspace = mkdtempSync(join(tmpdir(), "research-")); mkdirSync(join(workspace, ".proto-reference-research"));
 const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"; const ref = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
 const run = { id, terminal: true, status: "completed", references: [{ id: ref, app: "App", url: "https://source.test/screen", note: "Visible roles", assetPath: `/api/reference-research/${id}/images/${ref}` }] };
 const config = { app: "https://proto.test", credentials: [{ secret: "fixture-secret", team: { id: "team" } }] };
 try {
  await assert.rejects(() => saveSelected(workspace, "code", run, { config, fetcher: async () => new Response("<html/>", { headers: { "content-type": "text/html" } }) }), /not an image/);
  const output = await saveSelected(workspace, "code", run, { config, fetcher: async (url, options) => { assert.equal(url.origin, "https://proto.test"); assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, "Bearer fixture-secret"); return new Response(new Uint8Array([1,2,3]), { headers: { "content-type": "image/png" } }); } });
  assert.equal(output.references[0].image, `references/${ref}.png`); assert.equal(readFileSync(join(workspace, "public", output.references[0].image)).length, 3);
  await assert.rejects(() => saveSelected(workspace, "code", { ...run, references: [{ ...run.references[0], assetPath: "https://evil.test" }] }, { config }), /Invalid reference download path/);
 } finally { rmSync(workspace, { recursive: true, force: true }); }
});
