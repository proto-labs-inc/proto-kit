import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleFiles, bundleRevision } from "./application-alternates.mjs";
import { prepareSelectedForPr, verifyPrReady } from "./application-pr.mjs";

const git = (repo, ...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();

test("PR guard pins selected source, rejects preview wiring, and catches a changed shared choice", async () => {
  const home = mkdtempSync(join(tmpdir(), "proto-application-pr-"));
  try {
    const directory = join(home, "acme", "application-prototypes", "billing");
    const worktree = join(directory, "worktree");
    const app = join(worktree, "app");
    const setId = "11111111-1111-4111-8111-111111111111";
    const versionId = "22222222-2222-4222-8222-222222222222";
    mkdirSync(app, { recursive: true });
    mkdirSync(join(app, "node_modules"));
    git(worktree, "init", "-b", "proto/acme/billing");
    git(worktree, "config", "user.email", "test@example.invalid");
    git(worktree, "config", "user.name", "Test");
    writeFileSync(join(app, "page.tsx"), "export default function Page() { return <p>Old</p>; }\n");
    writeFileSync(join(app, "package.json"), '{"scripts":{"build":"true"}}');
    git(worktree, "add", ".");
    git(worktree, "commit", "-m", "base");
    writeFileSync(join(app, "page.tsx"), "import { ProtoAlternateBoundary } from '@proto-labs-inc/rig';\nexport default function Page() { return <p data-proto-id=\"billing\">Old</p>; }\n");
    const alternateStorage = join(directory, "alternates");
    const staging = join(alternateStorage, "staging");
    mkdirSync(staging, { recursive: true });
    writeFileSync(join(staging, "Billing.tsx"), "export default function Billing() { return <p>Chosen</p>; }\n");
    const revision = bundleRevision(staging);
    const source = join(alternateStorage, setId, revision);
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "Billing.tsx"), readFileSync(join(staging, "Billing.tsx")));
    writeFileSync(join(home, "acme", "codebase.json"), JSON.stringify({ team: { id: "team" } }));
    writeFileSync(join(directory, "prototype.json"), JSON.stringify({ codebase: "acme", slug: "billing", worktree, branch: "proto/acme/billing", appRoot: "app", alternateStorage }));
    let selectionRevision = 3;
    const deps = {
      home,
      readConfig: () => ({ app: "https://proto.invalid", credentials: [{ team: { id: "team" }, secret: "token" }] }),
      callTool: async (name) => ({ content: [{ text: JSON.stringify(name === "get_alternate_source"
        ? { id: versionId, set_id: setId, source_revision: revision, bundle: bundleFiles(source) }
        : { prototype: { selection_revision: selectionRevision, selected_alternates: { [setId]: versionId } },
          sets: [{ id: setId, target_key: "app/page.tsx#Page", version_id: versionId, source_revision: revision }] }) }] }),
      build: async () => {},
    };
    const input = { codebase: "acme", slug: "billing" };
    const prepared = await prepareSelectedForPr({ ...input, wiringPaths: ["app/page.tsx"] }, deps);
    assert.equal(prepared.selected[0].source, source);
    await assert.rejects(verifyPrReady(input, deps), /preview wiring/);
    writeFileSync(join(app, "page.tsx"), "export default function Page() { return <p>Chosen</p>; }\n");
    assert.equal((await verifyPrReady(input, deps)).ready, true);
    selectionRevision = 4;
    await assert.rejects(verifyPrReady(input, deps), /Shared selection/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
