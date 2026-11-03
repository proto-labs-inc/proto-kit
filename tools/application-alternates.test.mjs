import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleRevision, materializeApplicationAlternate, saveApplicationAlternate } from "./application-alternates.mjs";

test("alternate source is immutable outside the customer worktree and a retry keeps its revision", async () => {
  const home = mkdtempSync(join(tmpdir(), "proto-application-alternates-"));
  try {
    const prototype = join(home, "acme", "application-prototypes", "billing");
    const alternateStorage = join(prototype, "alternates");
    const worktree = join(prototype, "worktree");
    mkdirSync(join(worktree, "node_modules"), { recursive: true });
    const staging = join(alternateStorage, "staging", "first");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(home, "acme", "codebase.json"), JSON.stringify({ team: { id: "team" } }));
    writeFileSync(join(prototype, "prototype.json"), JSON.stringify({ codebase: "acme", slug: "billing", alternateStorage, worktree, appRoot: "" }));
    writeFileSync(join(staging, "Card.tsx"), "export default function Card() { return <div>First</div>; }\n");
    writeFileSync(join(staging, "Card.css"), ".card { color: blue; }\n");
    const calls = [];
    const versionId = "22222222-2222-4222-8222-222222222222";
    const deps = {
      home,
      readConfig: () => ({ app: "https://proto.invalid", credentials: [{ team: { id: "team" }, secret: "token" }] }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === "get_alternate_source") {
          const saved = calls.find(call => call.name === "save_alternate").args;
          return { content: [{ text: JSON.stringify({ id: versionId, set_id: args.setId, source_revision: saved.sourceRevision, bundle: saved.bundle }) }] };
        }
        return { content: [{ text: JSON.stringify({ id: versionId, sourceRevision: args.sourceRevision }) }] };
      },
    };
    const input = { codebase: "acme", slug: "billing", setId: "11111111-1111-4111-8111-111111111111", title: "First", staging };
    const first = await saveApplicationAlternate(input, deps);
    const second = await saveApplicationAlternate(input, deps);
    assert.equal(first.source, second.source);
    assert.equal(bundleRevision(first.source), calls[0].args.sourceRevision);
    assert.equal(calls[0].args.bundle.length, 2);
    assert.equal(readFileSync(join(first.source, "Card.tsx"), "utf8"), readFileSync(join(staging, "Card.tsx"), "utf8"));
    assert.ok(existsSync(`${first.source}.json`));
    assert.deepEqual(calls.map(call => call.name), ["save_alternate", "get_alternate_source", "save_alternate", "get_alternate_source"]);
    writeFileSync(join(first.source, "Card.tsx"), "changed");
    const retry = await saveApplicationAlternate(input, deps);
    assert.equal(retry.source, first.source);
    assert.equal(bundleRevision(retry.source), calls[0].args.sourceRevision);
    rmSync(first.source, { recursive: true });
    const restored = await materializeApplicationAlternate({ codebase: "acme", slug: "billing", setId: input.setId, versionId }, deps);
    assert.equal(restored.source, first.source);
    assert.equal(bundleRevision(restored.source), calls[0].args.sourceRevision);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("bundles refuse symlinked source", () => {
  const root = mkdtempSync(join(tmpdir(), "proto-alternate-symlink-"));
  try {
    writeFileSync(join(root, "Card.tsx"), "export default function Card() { return null; }");
    symlinkSync(join(root, "Card.tsx"), join(root, "linked.tsx"));
    assert.throws(() => bundleRevision(root), /symlinks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
