import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipTo, safeName, sessionAt, usesProto } from "./debug-report.mjs";

test("file names become plain path segments the site accepts", () => {
  assert.equal(safeName("session/subagents/agent-a1.jsonl"), "session/subagents/agent-a1.jsonl");
  assert.equal(safeName("proto/my codebase/.run/daemon.log"), "proto/my_codebase/_run/daemon.log");
  assert.equal(safeName("/abs//path\\x.log"), "abs/path/x.log");
});

test("a packed file is exactly the original, gzipped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  // 65535 ASCII bytes, so the 3-byte "—" straddles a 64 KiB read, and a
  // secret-looking string that must arrive untouched.
  const body = `${"a".repeat(65_535)}— and 🙂 sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA ${"b".repeat(70_000)}\n`;
  writeFileSync(join(dir, "in.jsonl"), body);
  const packed = await gzipTo({ name: "in.jsonl.gz", path: join(dir, "in.jsonl") }, dir);
  assert.equal(gunzipSync(readFileSync(packed.gz)).toString(), body);
});

test("binary files survive packing byte for byte", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0xc3]);
  writeFileSync(join(dir, "in.png"), bytes);
  const packed = await gzipTo({ name: "proto/in.png.gz", path: join(dir, "in.png") }, dir);
  assert.deepEqual(gunzipSync(readFileSync(packed.gz)), bytes);
});

test("a file that vanished before packing is skipped, not an error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  assert.equal(await gzipTo({ name: "gone.log.gz", path: join(dir, "gone.log") }, dir), null);
});

test("a session that touched Proto is recognised; one that did not is not", () => {
  assert.equal(usesProto('{"skill":"proto:create-prototype"}'), true);
  assert.equal(usesProto('{"name":"mcp__plugin_proto_proto__whoami"}'), true);
  assert.equal(usesProto('"file_path":"/Users/a/.proto/acme/library/x.tsx"'), true);
  assert.equal(usesProto('{"text":"refactor the billing page"}'), false);
});

test("a transcript path says which agent and session it is", () => {
  const claude = sessionAt("/Users/a/.claude/projects/-x/fc6eead5-4396-4450-925e-022cd814d1af.jsonl");
  assert.equal(claude.harness, "claude-code");
  assert.equal(claude.id, "fc6eead5-4396-4450-925e-022cd814d1af");
});
