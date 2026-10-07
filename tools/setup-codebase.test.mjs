import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupCodebase, atomicRecord } from "./setup-codebase.mjs";

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "proto-setup-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, "source"); mkdirSync(source);
  const credential = { team: { id: "team1", name: "One" }, secret: "do-not-print" };
  const calls = [];
  const deps = { home, config: () => ({ app: "https://example.test", credentials: [credential] }), call: async (...args) => {
    calls.push(args);
    return { content: [{ text: JSON.stringify({ codebase: "abc12345", team_id: "team1", name: "Source" }) }] };
  } };
  return { home, source, calls, deps, credential, options: { source, remote: "git@example.test:source.git", team: "team1" } };
}
test("creates once, reuses without registration, and records the actual page URL", async (t) => {
  const f = fixture(t);
  const created = await setupCodebase(f.options, f.deps);
  assert.equal(created.outcome, "created");
  assert.equal(f.calls[0][1].codebase, undefined);
  assert.equal(f.calls[0][2].secret, f.credential.secret);
  const recordPath = join(f.home, created.codebase, "codebase.json");
  const record = JSON.parse(readFileSync(recordPath)); record.extra = "keep"; atomicRecord(recordPath, record);
  const reused = await setupCodebase({ codebase: created.codebase, "live-url": "https://example.test/project" }, f.deps);
  assert.equal(reused.outcome, "reused"); assert.equal(f.calls.length, 1);
  assert.equal(reused.record.extra, "keep"); assert.equal(reused.record.createdAt, created.record.createdAt);
  assert.equal(reused.record.source.liveUrl, "https://example.test/project");
  assert.ok(!JSON.stringify(reused).includes(f.credential.secret));
});
test("recovers with the known ID and preserves record metadata", async (t) => {
  const f = fixture(t);
  atomicRecord(join(f.home, "abc12345", "codebase.json"), { codebase: "abc12345", team: f.credential.team, createdAt: "original", extra: 1, source: { path: "/missing", liveUrl: "https://example.test" } });
  const result = await setupCodebase({ ...f.options, codebase: "abc12345" }, f.deps);
  assert.equal(result.outcome, "recovered"); assert.equal(f.calls[0][1].codebase, "abc12345");
  assert.equal(result.record.createdAt, "original"); assert.equal(result.record.source.liveUrl, "https://example.test");
});
test("refuses ambiguous and conflicting teams", async (t) => {
  const f = fixture(t);
  f.deps.config = () => ({ app: "https://example.test", credentials: [f.credential, { team: { id: "team2" }, secret: "other" }] });
  await assert.rejects(setupCodebase({ source: f.source, remote: "remote" }, f.deps), /Choose a linked team/);
  await setupCodebase(f.options, f.deps);
  await assert.rejects(setupCodebase({ codebase: "abc12345", team: "team2" }, f.deps), /does not own/);
  assert.equal(f.calls.length, 1);
});
test("rejects invalid sources and missing remotes before cloud calls", async (t) => {
  const f = fixture(t);
  await assert.rejects(setupCodebase({ source: join(f.home, "missing") }, f.deps), /confirmed source/);
  await assert.rejects(setupCodebase({ source: f.source }, f.deps), /no Git origin/);
  await assert.rejects(setupCodebase({ ...f.options, codebase: "../escape" }, f.deps), /Invalid codebase/);
  assert.equal(f.calls.length, 0);
});
test("uncertain creation is not retried, and local write failures name the recovery ID", async (t) => {
  const f = fixture(t); let attempts = 0;
  await assert.rejects(setupCodebase(f.options, { ...f.deps, call: async () => { attempts++; throw new Error("network"); } }), /do not retry creation blindly/);
  assert.equal(attempts, 1);
  await assert.rejects(setupCodebase(f.options, { ...f.deps, save: () => { throw new Error("disk full"); } }), /--codebase abc12345/);
  await assert.rejects(setupCodebase(f.options, { ...f.deps, call: async () => ({ isError: true }) }), /refused/);
});
test("an atomic-write failure preserves the existing destination", (t) => {
  const f = fixture(t); const destination = join(f.home, "record");
  mkdirSync(destination); writeFileSync(join(destination, "keep"), "original");
  assert.throws(() => atomicRecord(destination, { updated: true }));
  assert.equal(readFileSync(join(destination, "keep"), "utf8"), "original");
});
