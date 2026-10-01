import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const removed = ["courier", "courier-up", "courier-http", "courier-relay", "feed-tail", "feed-watch-all", "feed-queue", "feed-drive", "agent-launch", "codex-thread"];
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]); }

test("retired transports, delivery entrypoints, listener roles and monitor manifests stay removed", () => {
  for (const name of removed) assert.equal(existsSync(join(kit, "tools", `${name}.mjs`)), false, name);
  for (const path of ["skills/listen/SKILL.md", "agents/listen.md", "codex-agents/proto-listen.toml", "monitors/monitors.json"]) assert.equal(existsSync(join(kit, path)), false, path);
  const manifest = JSON.parse(readFileSync(join(kit, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.monitors, undefined);
});

test("runtime imports resolve and contain no experimental delivery flag", () => {
  for (const path of files(join(kit, "tools")).filter((path) => path.endsWith(".mjs") && !path.endsWith(".test.mjs"))) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("PROTO_ENABLE_CODEX_COURIER"), false, path);
    for (const match of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+\.mjs)["']/g)) assert.equal(existsSync(resolve(dirname(path), match[1])), true, `${path}: missing ${match[1]}`);
  }
});

test("skills cannot invoke removed command-delivery tools", () => {
  const retiredInvocation = new RegExp(`(?:node\\s+[^\\n]*|tools/)(?:${removed.join("|")})\\.mjs`);
  for (const path of files(join(kit, "skills")).filter((path) => path.endsWith(".md"))) assert.doesNotMatch(readFileSync(path, "utf8"), retiredInvocation, path);
});

test("question schema has no transport and local library queue remains available", () => {
  assert.doesNotMatch(readFileSync(join(kit, "tools", "questions.mjs"), "utf8"), /node:fs|awaitAnswer|offset\.json|setInterval/);
  const queue = readFileSync(join(kit, "template", "library", "src", "queue-client.ts"), "utf8");
  assert.match(queue, /fetch\("queue\.json"/);
  assert.match(queue, /method: "POST"/);
  assert.match(readFileSync(join(kit, "template", "library", "vite.config.ts"), "utf8"), /req.method === "POST" && path === "\/queue.json"/);
});
