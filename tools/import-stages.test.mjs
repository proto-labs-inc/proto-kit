import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { componentStage, completeStage, refreshStages, requirePreviousStages, requireAllStages, STAGES } from "./import-stages.mjs";
import { checkFingerprint, paletteDigest } from "./import-evidence.mjs";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "proto-stages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, "library");
  mkdirSync(join(library, "public"), { recursive: true });
  writeFileSync(join(library, "package.json"), "{}");
  const palette = [{ name: "text", value: "#111", group: "text" }];
  const manifest = { startedAt: "run1", completedAt: null, codebase: "example", themes: { light: palette, dark: palette }, type: [{ name: "Body", family: "Arial", size: "14px", weight: 400, lineHeight: "20px", sample: "Example" }], components: [], verification: { surveys: {}, checks: {} }, importStages: STAGES.map((id) => ({ id })) };
  for (const theme of ["light", "dark"]) manifest.verification.surveys[theme] = { run: "run1", palette: paletteDigest(palette), capturedAt: "capture1" };
  for (const [slug, stage] of [["button", "core"], ["table", "extended"]]) {
    const folder = join(library, "src", "components", slug);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "component.json"), JSON.stringify({ states: [{ name: "Default" }, { name: "Hover" }] }));
    writeFileSync(join(folder, "Component.tsx"), "original");
    manifest.components.push({ slug, name: slug, stage, status: "done", states: [{ name: "Default" }, { name: "Hover" }] });
  }
  function verify(slug) {
    manifest.verification.checks[slug] = {};
    for (const theme of ["light", "dark"]) {
      const fingerprint = checkFingerprint(library, manifest, slug, theme);
      manifest.verification.checks[slug][theme] = Object.fromEntries(["Default", "Hover"].map((name) => [name, { fingerprint, typecheck: true, verdict: "match" }]));
    }
  }
  verify("button"); verify("table");
  const path = join(library, "public", "manifest.json");
  const save = () => writeFileSync(path, JSON.stringify(manifest)); save();
  return { library, manifest, verify, path, save };
}

test("common controls precede composites, with explicit overrides for product names", () => {
  for (const slug of ["button-primary", "checkbox", "form-field", "tabs", "dialog"]) assert.equal(componentStage({ slug }), "core");
  for (const slug of ["navigation", "table", "dashboard-panel"]) assert.equal(componentStage({ slug }), "extended");
  assert.equal(componentStage({ slug: "custom-widget", stage: "core" }), "core");
  assert.throws(() => componentStage({ slug: "button", stage: "unknown" }), /core or extended/);
});
test("stages must finish in order even if every component already passes", (t) => {
  const f = fixture(t);
  assert.throws(() => requirePreviousStages(f.library, f.manifest, "core"), /Finish Foundations/);
  assert.throws(() => completeStage(f.library, f.manifest, "extended"), /Finish Foundations/);
  completeStage(f.library, f.manifest, "foundations", "first");
  assert.deepEqual(f.manifest.importStages.map((s) => s.status), ["done", "active", "waiting"]);
  assert.throws(() => requirePreviousStages(f.library, f.manifest, "extended"), /Finish Core/);
  completeStage(f.library, f.manifest, "core");
  completeStage(f.library, f.manifest, "extended");
  requireAllStages(f.library, f.manifest);
  completeStage(f.library, f.manifest, "foundations", "retry");
  assert.equal(f.manifest.importStages[0].completedAt, "first");
});
test("a light-only pass blocks until explicitly recorded as a gap", (t) => {
  const f = fixture(t); completeStage(f.library, f.manifest, "foundations");
  delete f.manifest.verification.checks.button.dark.Hover;
  assert.throws(() => completeStage(f.library, f.manifest, "core"), /Hover.*dark/);
  assert.equal(f.manifest.importStages[1].verified, 0);
  assert.deepEqual(f.manifest.importStages[1].remaining, ["button"]);
  Object.assign(f.manifest.components[0], { status: "skipped", reason: "The dark hover differs", skipKind: "did-not-match" });
  completeStage(f.library, f.manifest, "core");
  requirePreviousStages(f.library, f.manifest, "extended");
  assert.equal(f.manifest.importStages[1].verified, 0);
  assert.deepEqual(f.manifest.importStages[1].remaining, []);
  assert.equal(f.manifest.importStages[1].gaps[0].reason, "The dark hover differs");
});
test("foundation evidence cannot be replaced with an empty or provisional palette", (t) => {
  const f = fixture(t);
  delete f.manifest.verification.surveys.dark;
  assert.throws(() => completeStage(f.library, f.manifest, "foundations"), /Survey dark/);
  f.manifest.themes.light = []; f.manifest.themes.dark = []; f.manifest.type = [];
  assert.throws(() => completeStage(f.library, f.manifest, "foundations"), /type styles/);
});
test("editing an earlier component invalidates it and all following checkpoints", (t) => {
  const f = fixture(t);
  for (const id of STAGES) completeStage(f.library, f.manifest, id);
  f.manifest.completedAt = "published";
  writeFileSync(join(f.library, "src", "components", "button", "Component.tsx"), "changed");
  refreshStages(f.library, f.manifest);
  assert.deepEqual(f.manifest.importStages.map((s) => s.status), ["done", "active", "waiting"]);
  assert.equal(f.manifest.completedAt, null);
  f.verify("button"); completeStage(f.library, f.manifest, "core");
  assert.throws(() => requireAllStages(f.library, f.manifest), /Extended/);
  completeStage(f.library, f.manifest, "extended");
  requireAllStages(f.library, f.manifest);
});
test("palette changes invalidate every checkpoint; empty component stages can finish explicitly", (t) => {
  const f = fixture(t); f.manifest.components = [];
  for (const id of STAGES) completeStage(f.library, f.manifest, id);
  f.manifest.themes.dark = [{ name: "text", value: "#fff", group: "text" }];
  refreshStages(f.library, f.manifest);
  assert.deepEqual(f.manifest.importStages.map((s) => s.status), ["active", "waiting", "waiting"]);
});
test("the writer enforces stage gates and final completion cannot bypass them", (t) => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [join(here, "library.mjs"), ...args], { encoding: "utf8" });
  assert.equal(run("component", f.library, "table", "status", "extracting").status, 1);
  assert.equal(run("complete", f.library).status, 1);
  assert.equal(run("stage", f.library, "foundations", "complete").status, 0);
  assert.equal(run("stage", f.library, "extended", "complete").status, 1);
  assert.equal(run("stage", f.library, "core", "complete").status, 0);
  assert.equal(run("stage", f.library, "extended", "complete").status, 0);
  assert.equal(run("complete", f.library).status, 0);
  assert.ok(JSON.parse(readFileSync(f.path)).completedAt);
});

test("failed captures without pictures can finish, but pending work still blocks", (t) => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [join(here, "library.mjs"), ...args], { encoding: "utf8" });
  assert.equal(run("stage", f.library, "foundations", "complete").status, 0);
  assert.equal(run("component", f.library, "button", "status", "extracting").status, 0);
  assert.equal(run("stage", f.library, "core", "complete").status, 1);
  const skipped = run("component", f.library, "button", "status", "skipped", "--kind", "could-not-isolate", "--reason", "The product did not show this control");
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.equal(run("stage", f.library, "core", "complete").status, 0);
  assert.equal(run("stage", f.library, "extended", "complete").status, 0);
  assert.equal(run("complete", f.library).status, 0);
  const saved = JSON.parse(readFileSync(f.path));
  assert.equal(saved.importStages[1].verified, 0);
  assert.equal(saved.importStages[1].gaps.length, 1);
  assert.ok(saved.completedAt);
});
