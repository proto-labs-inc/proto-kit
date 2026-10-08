import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { completionProblems, checkFingerprint, paletteDigest } from "./import-evidence.mjs";
import { finishImport } from "./finish-import.mjs";

const here = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), "proto-finish-test-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = join(home, "abc12345", "library"); const unit = join(library, "src", "components", "button");
  mkdirSync(unit, { recursive: true }); mkdirSync(join(library, "public"));
  writeFileSync(join(library, "package.json"), "{}");
  writeFileSync(join(unit, "component.json"), JSON.stringify({ states: [{ name: "Default" }, { name: "Hover" }] }));
  writeFileSync(join(unit, "Button.tsx"), "original");
  const palette = [{ name: "text", value: "#111", group: "text" }];
  const manifest = { startedAt: "run1", completedAt: null, codebase: "abc12345", themes: { light: palette, dark: [...palette] }, type: [], components: [{ slug: "button", status: "done" }], verification: { surveys: {}, checks: { button: {} } } };
  for (const theme of ["light", "dark"]) {
    manifest.verification.surveys[theme] = { run: "run1", palette: paletteDigest(palette), capturedAt: "capture1" };
    manifest.verification.checks.button[theme] = {};
    for (const state of ["Default", "Hover"]) manifest.verification.checks.button[theme][state] = { fingerprint: checkFingerprint(library, manifest, "button", theme), typecheck: true, verdict: "match" };
  }
  const path = join(library, "public", "manifest.json");
  const save = () => writeFileSync(path, JSON.stringify(manifest)); save();
  return { home, library, unit, manifest, save, path };
}
test("completion requires the current light survey and every state's passing check", (t) => {
  const f = fixture(t); assert.deepEqual(completionProblems(f.library, f.manifest), []);
  delete f.manifest.verification.checks.button.light.Hover;
  assert.match(completionProblems(f.library, f.manifest).join(), /Hover.*light/);
  delete f.manifest.verification.surveys.light;
  assert.match(completionProblems(f.library, f.manifest).join(), /Survey light/);
});
test("component edits, palette edits, and fresh imports invalidate evidence", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.unit, "Button.tsx"), "changed");
  assert.equal(completionProblems(f.library, f.manifest).filter((p) => p.includes("passing")).length, 2);
  f.manifest.themes.light = [{ name: "other", value: "#000" }];
  assert.match(completionProblems(f.library, f.manifest).join(), /Survey light/);
  f.manifest.startedAt = "run2";
  assert.match(completionProblems(f.library, f.manifest).join(), /Survey light/);
});
test("moving components block completion; explicit skips keep their reasons", (t) => {
  const f = fixture(t); f.manifest.components[0].status = "queued";
  assert.match(completionProblems(f.library, f.manifest).join(), /explicitly skip/);
  Object.assign(f.manifest.components[0], { status: "skipped", reason: "The hover still differs", skipKind: "did-not-match", screenshot: "button.png" });
  f.manifest.verification.checks = {};
  assert.deepEqual(completionProblems(f.library, f.manifest), []);
});
test("library complete cannot bypass verification and preserves the timestamp on retry", (t) => {
  const f = fixture(t);
  const run = () => spawnSync(process.execPath, [join(here, "library.mjs"), "complete", f.library], { encoding: "utf8" });
  assert.equal(run().status, 0);
  const completedAt = JSON.parse(readFileSync(f.path)).completedAt;
  assert.equal(run().status, 0); assert.equal(JSON.parse(readFileSync(f.path)).completedAt, completedAt);
  f.manifest.verification = null; f.save();
  const refused = run(); assert.equal(refused.status, 1); assert.match(refused.stderr, /Survey light/);
  assert.equal(JSON.parse(readFileSync(f.path)).completedAt, null);
});
test("finish publishes only after validation, waits, and retries a failed publication", async (t) => {
  const f = fixture(t); let failPublish = true; const calls = [];
  const run = (tool, args) => {
    calls.push([tool, args]);
    if (tool === "library.mjs") return spawnSync(process.execPath, [join(here, tool), ...args], { encoding: "utf8" });
    assert.equal(args.at(-1), "--wait");
    return { status: failPublish ? 1 : 0 };
  };
  await assert.rejects(finishImport("abc12345", { home: f.home, run }), /complete locally.*publication failed/);
  const completedAt = JSON.parse(readFileSync(f.path)).completedAt; assert.ok(completedAt);
  failPublish = false;
  const result = await finishImport("abc12345", { home: f.home, run });
  assert.equal(result.outcome, "published"); assert.equal(result.built, 1); assert.equal(result.completedAt, completedAt);
  f.manifest.components[0].status = "found"; f.save(); calls.length = 0;
  await assert.rejects(finishImport("abc12345", { home: f.home, run }), /finish or explicitly skip/);
  assert.equal(calls.length, 1);
});

test("the writer records checks, rejects races, and clears completion on palette changes", (t) => {
  const f = fixture(t);
  const run = (...args) => spawnSync(process.execPath, [join(here, "library.mjs"), ...args], { encoding: "utf8" });
  const evidence = { run: f.manifest.startedAt, fingerprint: checkFingerprint(f.library, f.manifest, "button", "light"), typecheck: true, states: [{ state: "Default", verdict: "differs" }] };
  assert.equal(run("checks", f.library, "button", "light", JSON.stringify(evidence)).status, 0);
  let current = JSON.parse(readFileSync(f.path));
  assert.match(completionProblems(f.library, current).join(), /Default.*light/);
  writeFileSync(join(f.unit, "Button.tsx"), "edited during check");
  assert.equal(run("checks", f.library, "button", "light", JSON.stringify(evidence)).status, 1);
  current.completedAt = "old completion"; writeFileSync(f.path, JSON.stringify(current));
  assert.equal(run("tokens", f.library, "light", JSON.stringify([{ name: "text", value: "#222", group: "text" }])).status, 0);
  current = JSON.parse(readFileSync(f.path)); assert.equal(current.completedAt, null);
  assert.match(completionProblems(f.library, current).join(), /Survey light/);
  assert.equal(run("survey", f.library, "light", JSON.stringify({ run: "wrong-run", palette: current.themes.light, capturedAt: "now" })).status, 1);
});

test("a fresh init resets evidence and old libraries stay readable but cannot finish", (t) => {
  const f = fixture(t); f.manifest.completedAt = "finished"; f.save();
  const result = spawnSync(process.execPath, [join(here, "library.mjs"), "init", f.library, "abc12345", "source", "--page-url", "https://example.test", "--page-title", "Example"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const current = JSON.parse(readFileSync(f.path)); assert.equal(current.verification, null);
  assert.match(completionProblems(f.library, current).join(), /Survey light/);
});

test("unused dark palettes and stale dark evidence do not block completion", (t) => {
  const f = fixture(t);
  f.manifest.themes.dark = [{ name: "unrelated", value: "#000" }];
  f.manifest.verification.surveys.dark = { run: "old" };
  f.manifest.verification.checks.button.dark = {};
  assert.deepEqual(completionProblems(f.library, f.manifest), []);
});

test("import rejects disabled dark mode before starting work", () => {
  for (const option of ["--theme", "--check-theme"]) {
    const result = spawnSync(process.execPath, [join(here, "import.mjs"), "unused", option, "dark"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Dark-mode importing is temporarily disabled/);
  }
});
