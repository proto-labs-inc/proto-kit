import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBuild, runPlan, planJobs, inPool, verifyConcurrency, checkWithRetry } from "./verify-screen.mjs";
import { validateVerification, widthsFor, widthsForCategory, widthsForScenario, widthsForControl, referenceWidths, boundarySides } from "./screen-verification.mjs";

const screen = {
  index_id: "022b489a-d73a-4ecf-a650-98926b38159b",
  source_url: "https://source.invalid/",
  bundle_checksum: "b".repeat(64),
  metadata: { preparedBuild: { sourceChecksum: "b".repeat(64), checksum: "d".repeat(64) } },
};
const inventory = (extra = {}) => ({
  sourceUrl: screen.source_url,
  capturedAt: "2026-11-01T00:00:00Z",
  controls: [{ id: "menu", expected: "Opens", state: "enabled" }],
  states: [{ id: "default", kind: "source" }],
  breakpoints: [767.98, 1024],
  ...extra,
});
const evidence = [`screen-indexes/${screen.index_id}/${"a".repeat(64)}.png`];
/** A passing report with exactly the checks the scoped matrix requires. */
function scopedReport(inv) {
  const scenarios = [];
  const add = (category, target) => {
    for (const width of widthsForCategory(inv, category))
      scenarios.push({ id: `${category}-${target}-${width}`, category, target, viewport: { width, height: 900 },
        ...(category === "responsive" ? { resizedFrom: width < 1024 ? 1440 : 390 } : {}),
        outcome: "passed", problems: [], evidence });
  };
  for (const category of ["visual", "responsive", "state", "isolation"]) add(category, "default");
  for (const category of ["interaction", "keyboard"]) add(category, "menu");
  return { version: 4, sourceChecksum: screen.bundle_checksum, buildChecksum: "d".repeat(64), inventory: inv, scenarios };
}

test("layout checks keep both sides of each boundary and a midpoint per band, without ±1 beyond", () => {
  assert.deepEqual(boundarySides(767.98), [767, 768]);
  assert.deepEqual(boundarySides(768), [767, 768, 769]);
  assert.deepEqual(widthsFor({ breakpoints: [767.98, 1024] }), [320, 544, 767, 768, 896, 1023, 1024, 1025, 1232, 1440]);
  assert.deepEqual(widthsFor({ breakpoints: [] }), [320, 880, 1440]);
});

test("each category runs at its own widths; container scenarios keep the layout set", () => {
  const inv = inventory();
  for (const category of ["visual", "responsive"])
    assert.deepEqual(widthsForScenario(inv, { category }), widthsFor(inv));
  for (const category of ["interaction", "keyboard"])
    assert.deepEqual(widthsForScenario(inv, { category }), [320, 1440]);
  for (const category of ["state", "isolation"])
    assert.deepEqual(widthsForScenario(inv, { category }), [1440]);
  const marked = inventory({ interactionBands: [[767.98, 1024]] });
  assert.deepEqual(widthsForScenario(marked, { category: "keyboard" }), [320, 896, 1440]);
  assert.deepEqual(widthsForScenario(inv, { category: "interaction", steps: [{ kind: "resize-container", selector: "#c", width: 250 }] }), widthsFor(inv));
  assert.deepEqual(widthsForScenario(inv, { category: "responsive", containerQuery: "cards (width > 250px)" }), widthsFor(inv));
  for (const interactionBands of [[[320, 1024]], [[768]], "all", [[700, 900]]])
    assert.throws(() => widthsForScenario(inventory({ interactionBands }), { category: "interaction" }), /interactionBands/);
});

test("validation accepts the scoped matrix, still accepts old full reports, and names what is missing", () => {
  const inv = inventory({ interactionBands: [[767.98, 1024]] });
  const report = scopedReport(inv);
  assert.equal(validateVerification(report, screen), report);
  const without = (filter) => ({ ...report, scenarios: report.scenarios.filter(s => !filter(s)) });
  assert.throws(() => validateVerification(without(s => s.category === "keyboard" && s.viewport.width === 896), screen), /keyboard check for menu at 896px/);
  assert.throws(() => validateVerification(without(s => s.category === "state"), screen), /state check for default at 1440px/);
  assert.throws(() => validateVerification(without(s => s.category === "visual" && s.viewport.width === 767), screen), /visual check for default at 767px/);
  assert.throws(() => validateVerification({ ...report, inventory: { ...inv, interactionBands: [[1, 2]] } }, screen), /interactionBands/);
  // A report from the previous full matrix is a superset and stays valid.
  const full = { ...report, scenarios: [] };
  for (const width of [...new Set([...widthsFor(inv), 766, 769, 896])])
    for (const [category, target] of [["visual", "default"], ["responsive", "default"], ["state", "default"], ["isolation", "default"], ["interaction", "menu"], ["keyboard", "menu"]])
      full.scenarios.push({ id: `${category}-${width}`, category, target, viewport: { width, height: 900 },
        ...(category === "responsive" ? { resizedFrom: width < 1024 ? 1440 : 390 } : {}), outcome: "passed", problems: [], evidence });
  assert.equal(validateVerification(full, screen), full);
  assert.ok(report.scenarios.length < full.scenarios.length / 2);
});

test("the pool bounds concurrency and keeps result order", async () => {
  let active = 0, peak = 0;
  const results = await inPool([...Array(20).keys()], 6, async (n) => {
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, (n * 7) % 13));
    active--;
    return n * 2;
  });
  assert.equal(peak, 6);
  assert.deepEqual(results, [...Array(20).keys()].map(n => n * 2));
  assert.equal(verifyConcurrency(undefined), 6);
  assert.equal(verifyConcurrency("3"), 3);
  for (const bad of ["0", "x", "1.5", "99"]) assert.throws(() => verifyConcurrency(bad), /PROTO_VERIFY_CONCURRENCY/);
});

test("a failing check is retried once and both outcomes are reported", async () => {
  let calls = 0;
  assert.deepEqual(await checkWithRetry(async () => (calls++, [])), { problems: [] });
  assert.equal(calls, 1);
  const flaky = [["Screenshot timed out"], []];
  assert.deepEqual(await checkWithRetry(async () => flaky.shift()), {
    problems: [],
    attempts: [{ outcome: "failed", problems: ["Screenshot timed out"] }, { outcome: "passed", problems: [] }],
  });
  let thrown = 0;
  const broken = await checkWithRetry(async () => { thrown++; throw new Error("CDP closed"); });
  assert.equal(thrown, 2);
  assert.deepEqual(broken.problems, ["CDP closed"]);
  assert.equal(broken.attempts.length, 2);
});

function fakeBuild(t) {
  const folder = mkdtempSync(join(tmpdir(), "proto-verify-speed-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, "index.html"), "<main>Page</main>");
  writeFileSync(join(folder, "prototype.json"), JSON.stringify({ states: [{ id: "default" }] }));
  const inv = inventory({ breakpoints: [] });
  const references = Object.fromEntries(widthsFor(inv).map(width => {
    const file = join(folder, `reference-${width}.png`);
    writeFileSync(file, `reference ${width}`);
    return [width, file];
  }));
  const plan = {
    inventory: inv,
    responsiveCss: { sourceUrl: inv.sourceUrl, breakpoints: [] },
    scenarios: [
      { id: "look", category: "visual", target: "default", assertion: "true", references },
      { id: "fit", category: "responsive", target: "default", assertion: "true", references },
      { id: "reload", category: "state", target: "default", assertion: "true" },
      { id: "alone", category: "isolation", target: "default", assertion: "true" },
      { id: "open", category: "interaction", target: "menu", steps: [{ kind: "click", selector: "#m" }], assertion: "document.body.dataset.menu === 'open'" },
      { id: "keys", category: "keyboard", target: "menu", steps: [{ kind: "key", key: "Enter" }], assertion: "document.body.dataset.menu === 'open'" },
    ],
  };
  return { folder, plan, output: join(folder, "out") };
}

test("verifyBuild runs the scoped matrix in a pool, retries, and resumes passed checks", async (t) => {
  const { folder, plan, output } = fakeBuild(t);
  const ran = [];
  let failOnce = new Set(["open-320"]), failAlways = new Set(["keys-1440"]);
  const runScenario = async (_url, scenario, out, viewport) => {
    const id = `${scenario.id}-${viewport.width}`;
    ran.push(id);
    await new Promise(r => setTimeout(r, Math.random() * 10));
    writeFileSync(out, `shot ${id} ${ran.length}`);
    if (failOnce.delete(id)) throw new Error("Invalid InterceptionId");
    return failAlways.has(id) ? ["Assertion timed out"] : [];
  };
  const first = await verifyBuild(folder, plan, screen, output, { runScenario, concurrency: 4 });
  // 3 layout widths × 2 layout scenarios + 1 state + 1 isolation + 2 widths × 2 controls.
  assert.equal(first.scenarios.length, 12);
  assert.deepEqual(first.scenarios.map(s => s.id), [
    "look-320", "fit-320", "open-320", "keys-320", "look-880", "fit-880",
    "look-1440", "fit-1440", "reload-1440", "alone-1440", "open-1440", "keys-1440"]);
  const retried = first.scenarios.find(s => s.id === "open-320");
  assert.equal(retried.outcome, "passed");
  assert.deepEqual(retried.attempts.map(a => a.outcome), ["failed", "passed"]);
  assert.deepEqual(retried.attempts[0].problems, ["Invalid InterceptionId"]);
  assert.ok(existsSync(join(output, "open-320.first-try.png")));
  const failed = first.scenarios.find(s => s.id === "keys-1440");
  assert.equal(failed.outcome, "failed");
  assert.deepEqual(failed.attempts.map(a => a.outcome), ["failed", "failed"]);
  assert.equal(ran.length, 14);
  assert.deepEqual(first.scenarios.find(s => s.id === "look-880").evidence, [join(output, "look-880.png"), plan.scenarios[0].references[880]]);

  // Same build and plan: only the failed check runs again.
  ran.length = 0;
  failAlways = new Set();
  const second = await verifyBuild(folder, plan, screen, output, { runScenario, concurrency: 4 });
  assert.deepEqual(ran, ["keys-1440"]);
  assert.equal(second.scenarios.filter(s => s.resumed).length, 11);
  assert.ok(second.scenarios.every(s => s.outcome === "passed"));
  assert.deepEqual(second.scenarios.map(s => s.id), first.scenarios.map(s => s.id));
  assert.deepEqual(JSON.parse(readFileSync(join(output, "report.json"), "utf8")).scenarios.length, 12);

  // A changed scenario, reference, evidence file or build reruns exactly what it affects.
  ran.length = 0;
  plan.scenarios[2] = { ...plan.scenarios[2], assertion: "1 === 1" };
  writeFileSync(plan.scenarios[0].references[880], "new reference");
  writeFileSync(join(output, "open-1440.png"), "tampered");
  await verifyBuild(folder, plan, screen, output, { runScenario, concurrency: 4 });
  assert.deepEqual(ran.sort(), ["fit-880", "look-880", "open-1440", "reload-1440"]); // both share the changed reference
  ran.length = 0;
  const rebuilt = structuredClone(screen);
  rebuilt.metadata.preparedBuild.checksum = "e".repeat(64);
  await verifyBuild(folder, plan, rebuilt, output, { runScenario, concurrency: 4 });
  assert.equal(ran.length, 12);
});

test("prepare-plan's run uses the same loop: scoped widths, filters, bail, retry, no checkpoints", async (t) => {
  const { folder, plan, output } = fakeBuild(t);
  // Narrowing to 880 and 1440 keeps each scenario's own widths: controls and
  // state checks never run at a layout-only width.
  assert.deepEqual(planJobs(plan, { widths: [880, 1440] }).map(j => j.id), [
    "look-880", "fit-880", "look-1440", "fit-1440", "reload-1440", "alone-1440", "open-1440", "keys-1440"]);
  assert.deepEqual(planJobs(plan, { only: /^open$/ }).map(j => j.id), ["open-320", "open-1440"]);
  const ran = [];
  const runScenario = async (_url, scenario, out, viewport) => {
    ran.push(`${scenario.id}-${viewport.width}`);
    writeFileSync(out, "shot");
    return scenario.id === "open" ? ["Assertion timed out"] : [];
  };
  const results = await runPlan(folder, plan, output, { only: ["open", "keys"], bail: true, concurrency: 1, runScenario });
  assert.deepEqual(results.map(r => [r.id, r.outcome]), [["open-320", "failed"]]);
  assert.deepEqual(ran, ["open-320", "open-320"], "retried once, then nothing new starts");
  assert.ok(!existsSync(join(output, "checkpoints")), "local runs keep no checkpoints");
  // References are needed exactly where screenshots are compared.
  assert.deepEqual(referenceWidths(plan.inventory, plan.scenarios), widthsFor(plan.inventory));
  assert.deepEqual(referenceWidths(plan.inventory, plan.scenarios.filter(s => s.category === "state")), []);
});

test("in the browser, concurrent lanes give the same report, retry a flaky load and resume", { skip: process.env.PROTO_BROWSER_TEST !== "1" }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "proto-verify-lanes-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  // The first load of each flaky URL at each width never says hello: a stand-in for a renderer hiccup.
  writeFileSync(join(folder, "index.html"), `<html><head><link rel="icon" href="data:,"></head><body><button id="open">Open</button><output>Closed</output><script>
  const key = 'loads' + location.search + innerWidth, loads = +(localStorage[key] || 0); localStorage[key] = loads + 1;
  document.querySelector('#open').onclick = () => document.querySelector('output').textContent = 'Opened';
  if (!location.search.includes('flaky') || loads > 0) parent.postMessage({type:'hello'}, '*');
  </script></body></html>`);
  writeFileSync(join(folder, "prototype.json"), JSON.stringify({ states: [{ id: "default" }] }));
  const run = Date.now() + Math.random().toString(36).slice(2);
  const inv = { ...inventory({ breakpoints: [] }), controls: [{ id: "open", expected: "Opens", state: "enabled" }] };
  const plan = {
    inventory: inv,
    responsiveCss: { sourceUrl: inv.sourceUrl, breakpoints: [] },
    scenarios: [
      ...[1, 2, 3, 4].map(n => ({ id: `open${n}`, category: "interaction", target: "open", path: `/?run=${run}&n=${n}`,
        steps: [{ kind: "click", selector: "#open" }], assertion: "document.querySelector('output').textContent === 'Opened'" })),
      { id: "keys", category: "keyboard", target: "open", path: `/?run=${run}`, steps: [{ kind: "key", key: "Tab" }, { kind: "key", key: "Enter" }],
        assertion: "document.querySelector('output').textContent === 'Opened'" },
      { id: "flaky", category: "state", target: "default", path: `/?run=${run}&flaky=1`, assertion: "!!document.querySelector('#open')" },
      { id: "alone", category: "isolation", target: "default", path: `/?run=${run}`, assertion: "!!document.querySelector('#open')" },
    ],
  };
  const parallel = await verifyBuild(folder, plan, screen, join(folder, "lanes"), { concurrency: 6 });
  const serial = await verifyBuild(folder, plan, screen, join(folder, "serial"), { concurrency: 1 });
  assert.deepEqual(parallel.scenarios.map(s => s.id), serial.scenarios.map(s => s.id));
  assert.ok(parallel.scenarios.every(s => s.outcome === "passed"), JSON.stringify(parallel.scenarios.filter(s => s.outcome !== "passed")));
  const flaky = parallel.scenarios.find(s => s.id === "flaky-1440");
  assert.deepEqual(flaky.attempts.map(a => a.outcome), ["failed", "passed"]);
  assert.ok(flaky.attempts[0].problems.some(p => p.includes("Assertion timed out")));
  const started = Date.now();
  const again = await verifyBuild(folder, plan, screen, join(folder, "lanes"), { concurrency: 6 });
  assert.ok(again.scenarios.every(s => s.resumed && s.outcome === "passed"));
  assert.ok(Date.now() - started < 2000, "a resumed run opens no pages");
});

test("a control's checks run at 320 and 1440 only where the source shows it, with a midpoint fallback", () => {
  const inv = inventory({ interactionBands: [[767.98, 1024]] });
  const layout = widthsFor(inv);
  const control = (widths) => ({ id: "c", expected: "Opens", state: "enabled", widths });
  // No recorded visibility: every control width, as before.
  assert.deepEqual(widthsForControl(inv, { id: "c" }), [320, 896, 1440]);
  assert.deepEqual(widthsForControl(inv, control(layout)), [320, 896, 1440]);
  // Phone-only menu button and desktop-only sidebar link.
  assert.deepEqual(widthsForControl(inv, control([320, 544, 767])), [320]);
  assert.deepEqual(widthsForControl(inv, control([768, 896, 1023, 1024, 1025, 1232, 1440])), [896, 1440]);
  // Tablet-only: neither endpoint, so the visible band midpoint.
  assert.deepEqual(widthsForControl(inventory(), control([768, 896, 1023])), [896]);
  // No visible midpoint: the visible width nearest one (the wider on a tie).
  assert.deepEqual(widthsForControl(inventory(), control([767, 768])), [768]);
  assert.throws(() => widthsForControl(inv, control([])), /widths must list/);
  assert.throws(() => widthsForControl(inv, control([320.5])), /widths must list/);
  // widthsForScenario reads the target control from the inventory.
  const phone = inventory({ controls: [control([320, 544])] });
  assert.deepEqual(widthsForScenario(phone, { category: "keyboard", target: "c" }), [320]);
  assert.deepEqual(widthsForScenario(phone, { category: "interaction", target: "c", steps: [{ kind: "resize-container", selector: "#c", width: 250 }] }), widthsFor(phone));
  // Validation requires exactly those widths for that control.
  const report = scopedReport(phone);
  report.scenarios = report.scenarios.filter(s => !["interaction", "keyboard"].includes(s.category));
  for (const category of ["interaction", "keyboard"])
    report.scenarios.push({ id: `${category}-c-320`, category, target: "c", viewport: { width: 320, height: 900 }, outcome: "passed", problems: [], evidence });
  assert.equal(validateVerification(report, screen), report);
  assert.throws(() => validateVerification({ ...report, scenarios: report.scenarios.filter(s => s.category !== "keyboard") }, screen), /keyboard check for c at 320px/);
  assert.throws(() => validateVerification({ ...report, inventory: { ...phone, controls: [control([])] } }, screen), /widths must list/);
});
