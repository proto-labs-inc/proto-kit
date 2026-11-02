import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSkeleton, mergePlan, lintPlan, containerThreshold, containerSteps, normalizeStates, mergeControls, capturePlan, responsiveTerms, VISIBLE_TEXT, statesOf, screenOfRunKey, referenceReporter } from "./prepare-plan.mjs";
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
  // The inventory records where each control is visible, so a desktop-only
  // link is checked at 1440 only and no state has to be invented for 320.
  const docs = plan.inventory.controls.find(c => c.id === "link-docs");
  assert.deepEqual(docs.widths, widthsFor({ breakpoints: [768] }).filter(w => w >= 768));
  assert.deepEqual(widthsForScenario(plan.inventory, plan.scenarios.find(s => s.id === "keyboard-link-docs")), [1440]);
  assert.deepEqual(widthsForScenario(plan.inventory, plan.scenarios.find(s => s.id === "pointer-button-save-changes")), [320, 1440]);
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

test("capture needs no states file: the default {} means the default state only", () => {
  assert.deepEqual(statesOf({}), []);
  assert.deepEqual(statesOf(), []);
  assert.deepEqual(normalizeStates(statesOf({})).map(s => s.id), ["default"]);
  assert.deepEqual(statesOf({ states: [{ id: "menu" }], containers: {} }), [{ id: "menu" }]);
  assert.deepEqual(statesOf([{ id: "menu" }]), [{ id: "menu" }]);
  assert.deepEqual(statesOf({ containers: { "(width >= 40rem)": ".cards" } }), []);
  assert.throws(() => statesOf("menu"), /states.json must be/);
});

const INDEX = "022b489a-d73a-4ecf-a650-98926b38159b";
const ENTRY = "6f1c2a9e-1111-4c2b-9d1e-0a0b0c0d0e0f";
test("a screen run key names its index, version and entry", () => {
  assert.deepEqual(screenOfRunKey(`${INDEX}-3-${ENTRY}`), { indexId: INDEX, version: 3, entryId: ENTRY });
  assert.throws(() => screenOfRunKey("brief-123"), /--run takes the screen run key/);
});

test("capture reports each reference to the screen's preparation stream as it is captured (mock site)", async (t) => {
  const puts = [];
  const site = createServer((req, res) => {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => { puts.push({ url: req.url, bytes: Buffer.concat(chunks) }); res.end(); });
  });
  await new Promise(done => site.listen(0, "127.0.0.1", done));
  t.after(() => site.close());
  const calls = [];
  const transport = async (tool, args) => {
    calls.push({ tool, args });
    const reply = (value) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
    if (args.operation === "capture") return reply({ uploadUrl: `http://127.0.0.1:${site.address().port}/${args.checksum}` });
    return reply({ ok: true });
  };
  const runKey = `${INDEX}-2-${ENTRY}`;
  const runDir = mkdtempSync(join(tmpdir(), "proto-screen-run-"));
  t.after(() => rmSync(runDir, { recursive: true, force: true }));
  const png = (n) => { const file = join(runDir, `ref-${n}.png`); writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(String(n))])); return file; };
  const onReference = referenceReporter({ codebase: "acme", runKey, runDir, transport });
  // No workspace.json yet (scaffold comes later): the run key names the entry.
  assert.equal(existsSync(join(runDir, "workspace.json")), false);
  await onReference({ file: png(1440), width: 1440, height: 900, url: "https://app.example/settings" });
  const first = calls.filter(c => c.args.operation === "build-events");
  assert.equal(first.length, 1, "the desktop reference leaves at once");
  assert.equal(first[0].tool, "screen_index");
  assert.deepEqual([first[0].args.indexId, first[0].args.version, first[0].args.entryId, first[0].args.codebase], [INDEX, 2, ENTRY, "acme"]);
  const [{ event }] = first[0].args.events;
  assert.equal(event.kind, "reference");
  assert.deepEqual([event.width, event.height, event.url], [1440, 900, "https://app.example/settings"]);
  assert.match(event.image, new RegExp(`^proto-screen://${INDEX}/[a-f0-9]{64}\\.png$`));
  assert.ok(event.reportId);
  assert.equal(puts.length, 1);
  await onReference({ file: png(320), width: 320, height: 900, url: "https://app.example/settings" });
  const events = calls.filter(c => c.args.operation === "build-events").flatMap(c => c.args.events.map(e => e.event));
  assert.deepEqual(events.map(e => [e.kind, e.width]), [["reference", 1440], ["reference", 320]], "each width is its own reference event, none sent twice");
  assert.equal(puts.length, 2);
});

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

// The freeze (tools/freeze.mjs SERIALIZE) rewrites every href that is not a
// fragment to an absolute URL against the source page; the same rewrite here.
const FREEZE_HREFS = `(() => { const body = document.body.cloneNode(true);
  for (const el of body.querySelectorAll('*')) for (const a of ['href', 'src']) { const v = el.getAttribute(a);
    if (v && !v.startsWith('#') && !v.startsWith('data:') && !v.startsWith('javascript:')) el.setAttribute(a, new URL(v, location.href).href); }
  for (const el of body.querySelectorAll('script')) el.remove();
  return '<!doctype html><html><body>' + body.innerHTML + '</body></html>'; })()`;

test("control selectors from the live page still find every control in the frozen copy", { skip: process.env.PROTO_BROWSER_TEST !== "1", timeout: 300_000 }, async (t) => {
  const { headlessPage } = await import("./cdp/headless.mjs");
  const { evaluate } = await import("./cdp/cdp.mjs");
  const live = `<!doctype html><html><body>
    <nav><a href="/org/acme/general">General</a><a href="billing?tab=invoices">Billing</a>
      <a href="http://HOST/org/acme/members">Members</a><a href="https://docs.example/guides">Docs</a><a href="#top">Top</a></nav>
    <main><h1>Settings</h1><a href="/org/acme/general">Edit general</a><button>Save</button>
      <button aria-label="Close panel">x</button><input name="org-name" value="Acme"></main></body></html>`;
  const source = createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(live.replace("HOST", req.headers.host)); });
  await new Promise(done => source.listen(0, "127.0.0.1", done));
  t.after(() => source.close());
  const url = `http://127.0.0.1:${source.address().port}/org/acme/settings`;
  const dir = mkdtempSync(join(tmpdir(), "proto-plan-freeze-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opened = await headlessPage(url, { width: 1440, height: 900 });
  t.after(() => opened.close());
  const result = await capturePlan({ page: opened.page, url, dir, states: {}, height: 600 });
  assert.deepEqual(result.captureProblems, []);
  // Links resolve by destination (scoped to their landmark when it repeats);
  // only an unlabelled, unnamed button needs a data-proto-id in the copy.
  assert.deepEqual(result.tagInCopy.map(n => n.id), ["button-save"]);
  const frozen = await evaluate(opened.page, FREEZE_HREFS);
  assert.match(frozen, /href="http:\/\/127\.0\.0\.1:\d+\/org\/acme\/billing\?tab=invoices"/, "the freeze made the hrefs absolute");
  // The copy is served from its own origin, as the workspace is.
  const copy = createServer((_req, res) => { res.setHeader("Content-Type", "text/html"); res.end(frozen); });
  await new Promise(done => copy.listen(0, "127.0.0.1", done));
  t.after(() => copy.close());
  const copyPage = await headlessPage(`http://127.0.0.1:${copy.address().port}/`, { width: 1440, height: 900 });
  t.after(() => copyPage.close());
  const plan = JSON.parse(readFileSync(result.plan, "utf8"));
  const selectors = plan.scenarios.filter(s => s.category === "interaction").map(s => [s.target, s.steps[0].selector]);
  assert.equal(selectors.length, 9);
  for (const [target, selector] of selectors) {
    if (selector.startsWith("[data-proto-id=")) continue;
    for (const page of [opened.page, copyPage.page])
      assert.equal(await evaluate(page, `document.querySelectorAll(${JSON.stringify(selector)}).length`), 1, `${target}: ${selector}`);
  }
  assert.equal(selectors.find(([target]) => target === "link-general")[1].split(",")[0], 'nav a[href="/org/acme/general"]');
});
