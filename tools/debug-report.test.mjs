import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, safeName } from "./debug-report.mjs";

test("file names become plain path segments the site accepts", () => {
  assert.equal(safeName("session/subagents/agent-a1.jsonl"), "session/subagents/agent-a1.jsonl");
  assert.equal(safeName("proto/my codebase/.run/daemon.log"), "proto/my_codebase/_run/daemon.log");
  assert.equal(safeName("/abs//path\\x.log"), "abs/path/x.log");
});

test("this laptop's Proto secrets are replaced wherever they appear", () => {
  const secret = "plt_0123456789abcdef";
  assert.equal(
    redact(`{"secret":"${secret}","again":"x${secret}y"}`, [secret]),
    '{"secret":"[redacted:proto-secret]","again":"x[redacted:proto-secret]y"}',
  );
});

test("strings shaped like credentials are replaced, the rest is kept", () => {
  const line = [
    "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk",
    "task-abcdefghijklmnopqrstuvwxyz0123456789 stays",
  ].join("\n");
  const out = redact(line, []);
  assert.match(out, /key \[redacted:anthropic-key\]/);
  assert.match(out, /gh \[redacted:github-token\]/);
  assert.match(out, /Bearer \[redacted:bearer\]/);
  assert.match(out, /jwt \[redacted:jwt\]/);
  assert.match(out, /task-abcdefghijklmnopqrstuvwxyz0123456789 stays/);
});

test("a packed file is the original, gzipped, with only credentials changed", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { gunzipSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { gzipTo } = await import("./debug-report.mjs");
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  const body = `${"x".repeat(200_000)}\nsecret plt_0123456789abcdef here\nlast line without newline`;
  writeFileSync(join(dir, "in.log"), body);
  const packed = await gzipTo({ name: "proto/in.log.gz", path: join(dir, "in.log") }, dir, ["plt_0123456789abcdef"]);
  assert.equal(gunzipSync(readFileSync(packed.gz)).toString(), body.replace("plt_0123456789abcdef", "[redacted:proto-secret]"));
});

test("characters split across read chunks arrive intact", async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
  const { gunzipSync } = await import("node:zlib");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { gzipTo } = await import("./debug-report.mjs");
  const dir = mkdtempSync(join(tmpdir(), "debug-report-test-"));
  // 65535 ASCII bytes, so the 3-byte "—" straddles the 64 KiB read boundary.
  const body = `${"a".repeat(65_535)}— and 🙂 ${"b".repeat(70_000)}\n`;
  writeFileSync(join(dir, "in.jsonl"), body);
  const packed = await gzipTo({ name: "in.jsonl.gz", path: join(dir, "in.jsonl") }, dir, []);
  assert.equal(gunzipSync(readFileSync(packed.gz)).toString(), body);
});
