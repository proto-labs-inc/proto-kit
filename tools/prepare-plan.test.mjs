import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSkeleton, mergePlan, lintPlan, containerThreshold, containerSteps, normalizeStates, mergeControls, capturePlan, responsiveTerms, VISIBLE_TEXT } from "./prepare-plan.mjs";
import { assertionProblems, preflightPlan, runPlan } from "./verify-screen.mjs";
import { widthsFor, widthsForScenario } from "./screen-verification.mjs";

const css = { sourceUrl: "https://source.invalid/settings", capturedAt: "2026-11-01T00:00:00.000Z", breakpoints: [768], unresolved: [], warnings: [], containerQueries: [] };
const control = (label, extra = {}) => ({ tag: "button", role: "", type: "", label, href: null, disabled: false, selector: `#${label.toLowerCase().replace(/ /g, "-")}`, stable: true, key: `button||${label}|`, ...extra });
function snapshots() {
  const widths = widthsFor({ breakpoints: [768] });
  const shot = (width, menu) => ({
    controls: [control("Save changes"), control("Delete project", { disabled: true }), ...(width >= 768 ? [control("Docs", { tag: "a", href: "#docs", key: "a||Docs|#docs", selector: "a[href=\"#docs\"]" })] : []),
      ...(menu ? [control("Pricing", { tag: "a", role: "menuitem", href: "#pricing", key: "a|menuitem|Pricing|#pricing", stable: false, selector: "body > div" })] : [])],
    tokens: ["Settings", "Save changes", ...(width >= 768 ? ["Docs"] : []), ...(menu ? ["Pricing"] : [])],
    headings: ["Settings"], overlays: menu ? 1 : 0,
  });
  return {
    default: Object.fromEntries(widths.map(width => [width, shot(width, false)])),
    menu: Object.fromEntries(widths.map(width => [width, shot(width, true)])),
  };
}
const states = normalizeStates([{ id: "menu", steps: [{ kind: "click", selector: "#menu-button" }] }]);

test("the skeleton fills every state assertion from the source and leaves only control outcomes", () => {
  const { plan, notes } = planSkeleton({ css, states, snapshots: snapshots() });
  assert.deepEqual(plan.inventory.states, [{ id: "default", kind: "source" }, { id: "menu", kind: "source" }]);
  assert.deepEqual(plan.inventory.controls.map(c => [c.id, c.state]), [
    ["button-save-changes", "enabled"], ["button-delete-project", "disabled"], ["link-docs", "enabled"], ["menuitem-pricing", "enabled"]]);
  const byId = Object.fromEntries(plan.scenarios.map(s => [s.id, s]));
  assert.match(byId["visual-default"].assertion, /seen\("Settings"\)/);
  assert.match(byId["visual-menu"].assertion, /seen\("Pricing"\)/);
  assert.match(byId["responsive-default"].assertion, /seen\("Docs"\)===\(innerWidth>=768\)/);
  assert.equal(byId["state-menu"].path, "/?state=menu");
  assert.equal(byId["pointer-menuitem-pricing"].path, "/?state=menu");
  assert.equal(byId["pointer-menuitem-pricing"].steps[0].selector, "[data-proto-id=\"menuitem-pricing\"]");
  assert.deepEqual(notes.tagInCopy.map(n => n.id), ["menuitem-pricing"]);
  assert.deepEqual(notes.partialWidth.map(n => n.id), ["link-docs"]);
  assert.doesNotMatch(byId["keyboard-button-delete-project"].assertion, /TODO/);
  assert.ok(byId["keyboard-button-delete-project"].steps.every(s => s.kind === "key"));
  const problems = lintPlan(plan, { files: false });
  // Only enabled controls' outcomes are left, plus their missing references.
  assert.ok(problems.some(p => /control button-save-changes/.test(p)));
  assert.ok(problems.some(p => /scenario pointer-button-save-changes/.test(p)));
  assert.ok(!problems.some(p => !/lacks reference PNGs/.test(p) && /visual-default|state-menu|delete-project/.test(p)), problems.join("\n"));
  assert.ok(problems.some(p => /lacks reference PNGs/.test(p)));
});

test("the visible-text helper is a valid copy-side expression", () => {
  assert.equal(typeof new Function(`return (${VISIBLE_TEXT})`)(), "function");
  assert.deepEqual(responsiveTerms(snapshots(), "menu"), [`seen("Docs")===(innerWidth>=768)`]);
});

test("interaction checks without an outcome, placeholders and pointer keyboard checks are refused", () => {
  const plan = { inventory: { controls: [{ id: "save", expected: "TODO: x", state: "enabled" }] }, scenarios: [
    { id: "pointer-save", category: "interaction", target: "save", steps: [{ kind: "click", selector: "#save" }], assertion: "true" },
    { id: "keyboard-save", category: "keyboard", target: "save", steps: [{ kind: "click", selector: "#save" }], assertion: "document.querySelector('output').textContent==='Saved'" },
    { id: "visual-default", category: "visual", target: "default", steps: [], assertion: "TODO: what" },
    { id: "broken", category: "state", target: "default", steps: [], assertion: "document.querySelector(" },
    { id: "empty", category: "interaction", target: "save", steps: [{ kind: "click", selector: "#save" }], assertion: " /* nothing */ " },
  ] };
  const problems = assertionProblems(plan).join("\n");
  assert.match(problems, /expected outcome of control save/);
  assert.match(problems, /pointer-save must assert/);
  assert.match(problems, /keyboard-save must use keyboard input only/);
  assert.match(problems, /TODO in scenario visual-default/);
  assert.match(problems, /broken has an invalid assertion/);
  assert.match(problems, /empty needs an assertion/);
  const folder = mkdtempSync(join(tmpdir(), "proto-preflight-"));
  try {
    writeFileSync(join(folder, "prototype.json"), "{}");
    const { plan: skeleton } = planSkeleton({ css, states, snapshots: snapshots() });
    assert.throws(() => preflightPlan(folder, skeleton), /plan is incomplete[\s\S]*button-save-changes/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test("capturing again keeps completed assertions and agent-added scenarios", () => {
  const first = planSkeleton({ css, states, snapshots: snapshots() }).plan;
  const filled = structuredClone(first);
  filled.inventory.controls[0].expected = "Shows Saved";
  const pointer = filled.scenarios.find(s => s.id === "pointer-button-save-changes");
  pointer.assertion = "document.querySelector('output').textContent==='Saved'";
  filled.scenarios.push({ id: "pointer-button-save-changes-twice", category: "interaction", target: "button-save-changes", steps: [{ kind: "click", selector: "#save" }], assertion: "x()" });
  const again = mergePlan(filled, planSkeleton({ css, states, snapshots: snapshots() }).plan);
  assert.equal(again.inventory.controls[0].expected, "Shows Saved");
  assert.equal(again.scenarios.find(s => s.id === "pointer-button-save-changes").assertion, pointer.assertion);
  assert.match(again.scenarios.find(s => s.id === "keyboard-button-save-changes").assertion, /^TODO/);
  assert.ok(again.scenarios.some(s => s.id === "pointer-button-save-changes-twice"));
});

test("container thresholds resolve px, em and rem and step below, at and above", () => {
  assert.equal(containerThreshold("(min-width: 400px)"), 400);
  assert.equal(containerThreshold("(width > 50em)", { fontSize: 10 }), 500);
  assert.equal(containerThreshold("(width >= 20rem)", { fontSize: 10, rootFontSize: 20 }), 400);
  assert.equal(containerThreshold("(orientation: portrait)"), null);
  assert.deepEqual(containerSteps(".cards", 400.5).filter(s => s.kind === "resize-container").map(s => s.width), [399, 400.5, 402]);
  const { plan } = planSkeleton({ css: { ...css, containerQueries: [{ source: "a.css", name: "", condition: "(min-width: 400px)", selectors: [".card"] }] },
    states, snapshots: snapshots(), containers: [{ query: { source: "a.css", name: "", condition: "(min-width: 400px)", selectors: [".card"] }, selector: ".cards", threshold: 400 }] });
  const scenario = plan.scenarios.find(s => s.containerQuery);
  assert.equal(scenario.category, "responsive");
  assert.ok(scenario.steps.some(s => s.kind === "resize-container" && s.selector === ".cards"));
});

test("states are validated and the default comes first", () => {
  assert.deepEqual(normalizeStates([]).map(s => s.id), ["default"]);
  assert.throws(() => normalizeStates([{ id: "bad id" }]), /filename-safe/);
  assert.throws(() => normalizeStates([{ id: "a" }, { id: "a" }]), /unique/);
  const boundary = normalizeStates([{ id: "outside", kind: "prototype-boundary", originatingControl: "link-docs", destination: "/docs", returnControl: "return", returnState: "default" }]);
  const { plan } = planSkeleton({ css, states: boundary, snapshots: { default: snapshots().default }, extraControls: [{ id: "return", selector: "#return", path: "/?state=outside" }] });
  assert.deepEqual(plan.scenarios.filter(s => s.target === "outside").map(s => s.category), ["responsive", "state", "isolation"]);
  assert.ok(plan.inventory.controls.some(c => c.id === "return"));
  assert.ok(!lintPlan(plan, { files: false }).some(p => /state outside|Invalid verification state/.test(p)));
  assert.equal(mergeControls({ default: { 320: { controls: [control("A"), control("A")] } } }, [{ id: "default" }]).length, 2);
});

// A small product page: links collapse below 768px, a menu and a button.
const page = (hello) => `<!doctype html><html><head><link rel="icon" href="data:,"><style>
body{margin:0;font:16px/1.4 sans-serif;color:#111;background:#fff}
header{display:flex;gap:12px;padding:8px;background:#eef}
.links{display:flex;gap:12px}
@media (max-width: 767.98px){.links{display:none}}
[role=menu]{position:absolute;top:48px;left:8px;background:#fff;border:1px solid #000;padding:8px}
main{padding:16px}
</style></head><body><header><button id="menu-button" aria-haspopup="menu" aria-expanded="false">Menu</button>
<nav class="links"><a href="#pricing">Pricing</a><a href="#docs">Docs</a></nav></header>
<main><h1>Settings</h1><button id="save">Save changes</button> <button id="delete" disabled>Delete project</button><p id="status"></p></main>
<script>
const params=()=>new URLSearchParams(location.search);
function render(){const open=params().get('state')==='menu';let menu=document.querySelector('[role=menu]');
  if(open&&!menu){menu=document.createElement('div');menu.setAttribute('role','menu');menu.innerHTML='<a role="menuitem" data-proto-id="menuitem-pricing-plans" href="#pricing">Pricing plans</a>';document.body.append(menu)}
  if(!open&&menu)menu.remove();
  document.querySelector('#menu-button').setAttribute('aria-expanded',String(open));}
document.querySelector('#menu-button').onclick=()=>{history.pushState({},'',params().get('state')==='menu'?location.pathname:'?state=menu');render()};
document.querySelector('#save').onclick=()=>{document.querySelector('#status').textContent='Saved'};
render();${hello ? "parent.postMessage({type:'hello'},'*');" : ""}
</script></body></html>`;

test("capture writes references, inventory and a plan that runs against a matching copy", { skip: process.env.PROTO_BROWSER_TEST !== "1", timeout: 600_000 }, async (t) => {
  const { headlessPage } = await import("./cdp/headless.mjs");
  const source = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(page(false)); });
  await new Promise(done => source.listen(0, "127.0.0.1", done));
  t.after(() => source.close());
  const url = `http://127.0.0.1:${source.address().port}/settings`;
  const dir = mkdtempSync(join(tmpdir(), "proto-prepare-plan-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opened = await headlessPage(url, { width: 1440, height: 900 });
  let result;
  try {
    result = await capturePlan({ page: opened.page, url, dir, states: [{ id: "menu", steps: [{ kind: "click", selector: "#menu-button" }] }], height: 600 });
  } finally { await opened.close(); }
  assert.deepEqual(result.captureProblems, []);
  const plan = JSON.parse((await import("node:fs")).readFileSync(result.plan, "utf8"));
  assert.ok(plan.inventory.breakpoints.includes(767.98));
  const widths = widthsFor(plan.inventory);
  assert.ok(widths.includes(767) && widths.includes(768));
  assert.equal(result.references, widths.length * 2);
  for (const width of widths) assert.ok(existsSync(plan.scenarios.find(s => s.id === "visual-menu").references[width]));
  // Captured with the verifier's render profile: exact CSS viewport at 1x.
  const { pngSize } = await import("./cdp/render-profile.mjs");
  for (const width of widths)
    assert.deepEqual(pngSize((await import("node:fs")).readFileSync(plan.scenarios.find(s => s.id === "visual-menu").references[width])), [width, 600]);
  const ids = plan.inventory.controls.map(c => c.id);
  for (const id of ["button-menu", "link-pricing", "link-docs", "button-save-changes", "button-delete-project", "menuitem-pricing-plans"]) assert.ok(ids.includes(id), ids.join());
  assert.equal(plan.inventory.controls.find(c => c.id === "button-delete-project").state, "disabled");
  assert.match(plan.scenarios.find(s => s.id === "responsive-default").assertion, /seen\("Docs"\)===\(innerWidth>=768\)/);
  assert.match(plan.scenarios.find(s => s.id === "visual-menu").assertion, /Pricing plans/);
  assert.ok(result.toFill.every(p => /TODO|expected outcome/.test(p)), result.toFill.join("\n"));

  // Fill only the enabled controls' outcomes, as the skill asks.
  const outcomes = {
    "button-menu": "document.querySelector('#menu-button').getAttribute('aria-expanded')==='true'&&!!document.querySelector('[role=menu]')",
    "link-pricing": "location.hash==='#pricing'", "link-docs": "location.hash==='#docs'", "menuitem-pricing-plans": "location.hash==='#pricing'",
    "button-save-changes": "document.querySelector('#status').textContent==='Saved'",
  };
  for (const c of plan.inventory.controls) if (c.expected.startsWith("TODO")) c.expected = "Shows its outcome";
  for (const s of plan.scenarios) if (outcomes[s.target] && s.assertion.startsWith("TODO")) s.assertion = outcomes[s.target];
  assert.deepEqual(lintPlan(plan), []);

  const copy = join(dir, "dist");
  (await import("node:fs")).mkdirSync(copy);
  writeFileSync(join(copy, "index.html"), page(true));
  writeFileSync(join(copy, "prototype.json"), JSON.stringify({ states: [{ id: "default" }, { id: "menu" }] }));
  preflightPlan(copy, plan);
  // The header links exist only from 768px; the tool reports them for the agent to resolve.
  assert.deepEqual(result.partialWidth.map(n => n.id).sort(), ["link-docs", "link-pricing"]);
  const results = await runPlan(copy, plan, join(dir, "out"), { widths: [768, 1440], concurrency: 4 });
  const failed = results.filter(r => r.outcome !== "passed");
  assert.deepEqual(failed.map(r => `${r.id}: ${r.problems.join(" | ")}`), []);
  // Each scenario runs only at the narrowed widths its category needs.
  assert.equal(results.length, plan.scenarios.reduce((n, s) => n + widthsForScenario(plan.inventory, s).filter(w => [768, 1440].includes(w)).length, 0));
  assert.ok(results.every(r => !["interaction", "keyboard", "state", "isolation"].includes(r.category) || r.viewport.width === 1440));

  const broken = structuredClone(plan);
  broken.scenarios.find(s => s.id === "pointer-button-save-changes").assertion = "document.querySelector('#status').textContent==='Nope'";
  const bailed = await runPlan(copy, broken, join(dir, "bail"), { only: ["pointer-button-save-changes", "visual-default"], bail: true, concurrency: 1 });
  assert.equal(bailed.filter(r => r.outcome === "failed").length, 1);
  assert.ok(bailed.length < widths.length * 2, "stops starting scenarios after the first failure");
});
