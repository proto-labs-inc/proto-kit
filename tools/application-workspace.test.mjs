import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationWorkspace } from "./application-workspace.mjs";

const run = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

test("an application prototype gets one customer worktree from local main and retries without changing the checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "proto-application-workspace-"));
  try {
    const repo = join(root, "customer");
    const home = join(root, "managed");
    mkdirSync(repo);
    mkdirSync(join(home, "acme"), { recursive: true });
    run(repo, "init", "-b", "main");
    run(repo, "config", "user.email", "test@example.invalid");
    run(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "package.json"), '{"scripts":{"dev":"next dev"}}');
    run(repo, "add", "package.json");
    run(repo, "commit", "-m", "baseline");
    const main = run(repo, "rev-parse", "main");
    writeFileSync(join(home, "acme", "codebase.json"), JSON.stringify({ codebase: "acme", team: { id: "team" }, source: { kind: "repository", path: repo } }));
    const calls = [];
    const dependencies = {
      home,
      readConfig: () => ({ app: "https://proto.invalid", credentials: [{ team: { id: "team" }, secret: "token" }] }),
      callTool: async (name, args) => { calls.push({ name, args }); return { content: [{ text: JSON.stringify({ id: "cloud-id" }) }] }; },
    };
    const input = { codebase: "acme", slug: "billing", route: "/settings/billing", title: "Billing", request: "Explore billing layout" };
    const first = await createApplicationWorkspace(input, dependencies);
    const second = await createApplicationWorkspace(input, dependencies);
    assert.equal(first.record.worktree, second.record.worktree);
    assert.equal(run(first.record.worktree, "branch", "--show-current"), "proto/acme/billing");
    assert.equal(run(first.record.worktree, "rev-parse", "HEAD"), main);
    assert.equal(run(repo, "branch", "--show-current"), "main");
    assert.equal(readFileSync(join(first.record.worktree, "package.json"), "utf8"), '{"scripts":{"dev":"next dev"}}');
    assert.deepEqual(calls.map(call => call.name), ["create_prototype", "create_prototype"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
