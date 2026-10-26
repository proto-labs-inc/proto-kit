import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBuild, runScenario, smokeBuild, verifyBuild, validateMapStates, validateResponsivePlan, captureProfileFor, applyCaptureMedia, sampleAnimations } from "./verify-screen.mjs";
import { validateVerification, widthsFor } from "./screen-verification.mjs";

test("verification rejects absent evidence, stale artifacts and missing keyboard coverage", () => {
  const screen = {
    index_id: "022b489a-d73a-4ecf-a650-98926b38159b",
    source_url: "https://source.invalid/",
    bundle_checksum: "b".repeat(64),
    metadata: {
      preparedBuild: {
        sourceChecksum: "b".repeat(64),
        checksum: "d".repeat(64),
      },
    },
  };
  const report = {
    version: 4,
    sourceChecksum: screen.bundle_checksum,
    buildChecksum: "d".repeat(64),
    inventory: {
      sourceUrl: screen.source_url,
      capturedAt: new Date().toISOString(),
      controls: [{ id: "menu", expected: "Opens", state: "enabled" }],
      states: [{ id: "default", kind: "source" }],
      breakpoints: [],
    },
    scenarios: widthsFor({ breakpoints: [] }).flatMap((width) =>
      [
        "visual",
        "responsive",
        "state",
        "isolation",
        "interaction",
        "keyboard",
      ].map((category) => ({
        id: `${category}-${width}`,
        category,
        target: ["keyboard", "interaction"].includes(category)
          ? "menu"
          : "default",
        viewport: { width, height: 900 },
        ...(category === "responsive" ? { resizedFrom: width < 1024 ? 1440 : 390 } : {}),
        outcome: "passed",
        problems: [],
        evidence: [`screen-indexes/${screen.index_id}/${"a".repeat(64)}.png`],
      })),
    ),
  };
  assert.equal(validateVerification(report, screen), report);
  assert.throws(() => validateVerification({ ...report, version: 0 }, screen));
  assert.throws(() =>
    validateVerification({ ...report, buildChecksum: "e".repeat(64) }, screen),
  );
  assert.throws(
    () =>
      validateVerification(
        {
          ...report,
          scenarios: report.scenarios.filter((s) => s.category !== "keyboard"),
        },
        screen,
      ),
    /keyboard/,
  );
});

test(
  "compiled browser checks catch dead controls, broken state, clipping and external requests",
  { skip: process.env.PROTO_BROWSER_TEST !== "1" },
  async (t) => {
    const folder = mkdtempSync(join(tmpdir(), "proto-browser-test-"));
    t.after(() => rmSync(folder, { recursive: true, force: true }));
    const html = `<html><head><link rel="icon" href="data:,"></head><body><button id="open">Open</button><button id="dead">Dead</button><output></output><script>
  const render=()=>document.querySelector('output').textContent=new URLSearchParams(location.search).get('dialog')==='open'?'Opened':'Closed';render();
  document.querySelector('#open').onclick=()=>{history.pushState({},'', '?dialog=open');render()};
  parent.postMessage({type:'hello'},'*');
  </script></body></html>`;
    writeFileSync(join(folder, "index.html"), html);
    const server = await serveBuild(folder);
    t.after(() => server.close());
    const run = (scenario) =>
      runScenario(server.url, scenario, join(folder, "evidence.png"), {
        width: 390,
        height: 900,
      });
    const working = {
      category: "interaction",
      steps: [{ kind: "click", selector: "#open" }],
      assertion: `document.querySelector('output').textContent==='Opened'`,
    };
    assert.deepEqual(await run(working), []);
    const keyboard = {
      ...working,
      category: "keyboard",
      steps: [
        { kind: "key", key: "Tab" },
        { kind: "key", key: "Enter" },
      ],
    };
    assert.deepEqual(await run(keyboard), []);
    const reference = join(folder, "reference.png");
    await runScenario(server.url, working, reference, {
      width: 390,
      height: 900,
    });
    writeFileSync(
      join(folder, "index.html"),
      html.replace("<body>", '<body style="background:blue">'),
    );
    const visual = await runScenario(
      server.url,
      { ...working, category: "visual" },
      join(folder, "visual.png"),
      { width: 390, height: 900 },
      reference,
    );
    assert.ok(visual.some((problem) => problem.includes("Visual mismatch")));
    writeFileSync(join(folder, "index.html"), html);
    const dead = await run({
      ...working,
      steps: [{ kind: "click", selector: "#dead" }],
    });
    assert.ok(dead.some((p) => p.includes("Assertion timed out")));
    assert.deepEqual(await run({ ...working, category: "state" }), []);
    writeFileSync(
      join(folder, "index.html"),
      html.replace(
        "history.pushState({},'', '?dialog=open');render()",
        "document.querySelector('output').textContent='Opened'",
      ),
    );
    const state = await run({ ...working, category: "state" });
    assert.ok(state.some((p) => p.includes("Assertion timed out")));
    writeFileSync(
      join(folder, "index.html"),
      html.replace("<body>", '<body><div style="width:1000px">Wide</div>'),
    );
    assert.ok((await run(working)).includes("Horizontal page overflow"));
    writeFileSync(
      join(folder, "index.html"),
      html.replace(
        "parent.postMessage",
        "fetch('https://product.invalid/api/write',{method:'POST'}).catch(()=>{});parent.postMessage",
      ),
    );
    assert.ok(
      (await run(working)).some(
        (p) =>
          p.includes("External request blocked") ||
          p.includes("ERR_BLOCKED_BY_CSP") ||
          p.includes("Blocked request: csp"),
      ),
    );
    writeFileSync(join(folder, "index.html"), html);
    await assert.rejects(
      smokeBuild(folder, { dialog: "open" }),
      /Copied starter failed/,
    );
    writeFileSync(
      join(folder, "index.html"),
      html.replace(
        "const render=",
        "if(!location.search)history.replaceState({},'', '?dialog=open');const render=",
      ),
    );
    await smokeBuild(folder, { dialog: "open" });
  },
);


test("responsive browser checks catch mount-only layouts and ancestor clipping", { skip: process.env.PROTO_BROWSER_TEST !== "1" }, async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "proto-responsive-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const server = await serveBuild(folder);
  t.after(() => server.close());
  const write = (body, script = "", css = "") => writeFileSync(join(folder, "index.html"),
    `<html><head><link rel="icon" href="data:,"><style>body{margin:0}${css}</style></head><body>${body}<script>${script};parent.postMessage({type:'hello'},'*')</script></body></html>`);
  const run = async (category, assertion) => {
    const viewport = { width: 390, height: 600 };
    const reference = join(folder, "reference.png");
    if (category === "responsive")
      await runScenario(server.url, { category: "smoke", assertion: "true" }, reference, viewport);
    return runScenario(server.url, { category, assertion }, join(folder, "evidence.png"), viewport, reference);
  };
  write('<main>Page</main>', "document.querySelector('main').style.width=innerWidth+'px'");
  const fits = "document.querySelector('main').getBoundingClientRect().width === innerWidth";
  assert.deepEqual(await run("interaction", fits), []);
  assert.ok((await run("responsive", fits)).some(p => p.includes("Assertion timed out")));
  // Even a weak authored assertion cannot pass a visually wrong resized layout.
  write('<main>Page</main>', "document.querySelector('main').style.background=innerWidth<600?'white':'blue'", 'main{height:200px}');
  assert.ok((await run("responsive", "true")).some(p => p.includes("Visual mismatch")));

  write('<main>Page</main>', "", 'main{width:100%}@media(max-width:600px){main{display:grid}}');
  assert.deepEqual(await run("responsive", fits + " && window.getComputedStyle(document.querySelector('main')).display==='grid'"), []);

  // The document itself fits: only the parent clips this control.
  write('<div style="width:100px;overflow:hidden"><button id="clipped" style="width:200px">Clipped</button></div>');
  assert.ok((await run("responsive", "true")).some(p => p.includes("Control clipped by ancestor")));
  write('<div style="height:10px;overflow:hidden"><button style="height:40px">Clipped vertically</button></div>');
  assert.ok((await run("responsive", "true")).some(p => p.includes("clipped vertically")));

  // A real scroll region remains usable; a hidden drawer is not an exposed control.
  write('<div style="width:100px;overflow:auto"><button style="width:200px">Scroll to reach</button></div><button style="visibility:hidden;position:absolute;left:-100px">Hidden drawer</button>');
  assert.deepEqual(await run("responsive", "true"), []);
});


test("verification requires compiled CSS coverage and explicit container checks", () => {
  const plan = { inventory: {sourceUrl:"https://source.invalid", states:[{id:"default",kind:"source"}], breakpoints:[848]}, responsiveCss: {sourceUrl:"https://source.invalid",breakpoints:[848],containerQueries:[],warnings:[],unresolved:[]}, scenarios:[] };
  assert.doesNotThrow(()=>validateResponsivePlan(plan));
  assert.throws(()=>validateResponsivePlan({...plan,responsiveCss:null}),/responsive-css/);
  assert.throws(()=>validateResponsivePlan({...plan,inventory:{...plan.inventory,breakpoints:[]}}),/omits/);
  const unresolved = {...plan,responsiveCss:{...plan.responsiveCss,unresolved:['(orientation:portrait)']}};
  assert.throws(()=>validateResponsivePlan(unresolved),/unresolved/);
  assert.doesNotThrow(()=>validateResponsivePlan({...unresolved,responsiveCssReview:{'(orientation:portrait)':'Inspected source and added portrait and landscape references.'}}));
  const container = {...plan,responsiveCss:{...plan.responsiveCss,containerQueries:[{condition:'cards (width > 250px)'}]}};
  assert.throws(()=>validateResponsivePlan(container),/container-size/);
  assert.doesNotThrow(()=>validateResponsivePlan({...container,scenarios:[{category:'responsive',target:'default',containerQuery:'cards (width > 250px)',steps:[{kind:'resize-container',selector:'#cards',width:250}]}]}));
});

test("container scenarios resize the container independently of the viewport", {skip:process.env.PROTO_BROWSER_TEST!=="1"}, async t => {
  const folder=mkdtempSync(join(tmpdir(),'proto-container-test-'));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  writeFileSync(join(folder,'index.html'), `<html><head><link rel="icon" href="data:,"><style>#cards{container-type:inline-size}.card{display:block}@container(width > 250px){.card{display:grid}}</style></head><body><div id="cards"><div class="card">Card</div></div><script>parent.postMessage({type:'hello'},'*')</script></body></html>`);
  const server=await serveBuild(folder);t.after(()=>server.close());
  const display = value => `window.getComputedStyle(document.querySelector('.card')).display==='${value}'`;
  const problems = await runScenario(server.url,{category:'interaction',steps:[
    {kind:'resize-container',selector:'#cards',width:249}, {kind:'assert',expression:display('block')},
    {kind:'resize-container',selector:'#cards',width:251}, {kind:'assert',expression:display('grid')},
    {kind:'resize-container',selector:'#cards',width:250},
  ],assertion:display('block')},join(folder,'container.png'),{width:390,height:600});
  assert.deepEqual(problems,[]);
});


test("capture profiles are explicit, inherited and validated without changing normal captures", async () => {
  const plan = { capture: { reducedMotion: "reduce", animationTimeMs: 3000.003 } };
  assert.deepEqual(captureProfileFor(), {});
  assert.deepEqual(captureProfileFor(plan), plan.capture);
  assert.deepEqual(captureProfileFor(plan, { capture: {} }), {});
  assert.deepEqual(captureProfileFor(plan, { capture: { animationTimeMs: 0 } }), { animationTimeMs: 0 });
  for (const value of [-1, Infinity, NaN, "1000", null])
    assert.throws(() => captureProfileFor({ capture: { animationTimeMs: value } }), /finite nonnegative/);
  for (const capture of [null, [], true])
    assert.throws(() => captureProfileFor({ capture }), /must be an object/);
  assert.throws(() => captureProfileFor({ capture: { reducedMotion: "always" } }), /reduce or no-preference/);
  assert.throws(() => captureProfileFor({ capture: { animationTime: 1000 } }), /Unknown/);
  const calls = [];
  const page = { send: async (...args) => calls.push(args) };
  await applyCaptureMedia(page, {});
  assert.deepEqual(calls, []);
  await applyCaptureMedia(page, captureProfileFor(plan));
  assert.deepEqual(calls, [["Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  }]]);
});

test("snapshot sampling pauses every animation before seeking to its declared frame", () => {
  const calls = [];
  const animation = name => ({
    pause() { calls.push([name, "pause"]); },
    set currentTime(value) { calls.push([name, "time", value]); },
  });
  const document = { getAnimations: () => [animation("entrance"), animation("continuous")] };
  assert.equal(sampleAnimations(document, 3000.003), 2);
  assert.deepEqual(calls, [
    ["entrance", "pause"], ["entrance", "time", 3000.003],
    ["continuous", "pause"], ["continuous", "time", 3000.003],
  ]);
});

test("browser capture media applies before source scripts and records the sampled profile", { skip: process.env.PROTO_BROWSER_TEST !== "1" }, async t => {
  const folder = mkdtempSync(join(tmpdir(), "proto-motion-test-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  writeFileSync(join(folder, "index.html"), `<html><head><link rel="icon" href="data:,"><style>
  #moving{width:20px;height:20px;background:red;animation:slide 10s linear infinite}@keyframes slide{to{transform:translateX(100px)}}
  </style></head><body><div id="moving">Motion</div><script>
  window.bootMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  parent.postMessage({type:'hello'},'*');</script></body></html>`);
  const server = await serveBuild(folder); t.after(() => server.close());
  const metadata = {};
  const capture = { reducedMotion: "reduce", animationTimeMs: 2000 };
  const problems = await runScenario(server.url, {
    category: "smoke", capture, assertion: "window.bootMotion===true",
  }, join(folder, "sample.png"), { width: 390, height: 600 }, undefined, metadata);
  assert.deepEqual(problems, []);
  assert.deepEqual(metadata, { profile: capture, reducedMotion: "reduce", sampledAnimations: 1 });
  const normal = await runScenario(server.url, {
    category: "smoke", capture: { reducedMotion: "no-preference" },
    assertion: "window.bootMotion===false && document.getAnimations()[0].playState==='running'",
  }, join(folder, "normal.png"), { width: 390, height: 600 });
  assert.deepEqual(normal, []);
});

const boundaryScreen = { index_id: "022b489a-d73a-4ecf-a650-98926b38159b", source_url: "https://source.invalid/",
 bundle_checksum: "b".repeat(64), metadata: { preparedBuild: { sourceChecksum: "b".repeat(64), checksum: "d".repeat(64) } } };
const boundaryBase = { version: 4, sourceChecksum: boundaryScreen.bundle_checksum, buildChecksum: "d".repeat(64),
 inventory: {sourceUrl: boundaryScreen.source_url, capturedAt: new Date().toISOString(), controls:[{id:"menu",state:"enabled",expected:"Open"}], states:[{id:"default",kind:"source"}],breakpoints:[]},
 scenarios: widthsFor({breakpoints:[]}).flatMap(width => ["visual","responsive","state","isolation","interaction","keyboard"].map(category => ({
 id:`${category}-${width}`, category, target:["interaction","keyboard"].includes(category)?"menu":"default", viewport:{width,height:900},
 outcome:"passed",problems:[],evidence:[`screen-indexes/${boundaryScreen.index_id}/${"a".repeat(64)}.png`],
 ...(category === "responsive" ? {resizedFrom:width<1024?1440:390}:{}) }))) };
function acceptsBoundary(report) { try { validateVerification(report,boundaryScreen); return true; } catch { return false; } }

function boundaryReport() {
  const value = structuredClone(boundaryBase);
  value.inventory.controls.push({ id: "return", state: "enabled", expected: "Returns to the copied screen" });
  value.inventory.states.push({ id: "outside", kind: "prototype-boundary", originatingControl: "menu",
    destination: "/uncopied", returnControl: "return", returnState: "default" });
  for (const width of widthsFor(value.inventory)) {
    const evidence = value.scenarios.find(s => s.viewport.width === width).evidence;
    for (const category of ["responsive", "state", "isolation", "interaction", "keyboard"]) {
      value.scenarios.push({ id: `boundary-${category}-${width}`, category,
        target: ["interaction", "keyboard"].includes(category) ? "return" : "outside",
        viewport: { width, height: 900 }, outcome: "passed", problems: [], evidence,
        ...(category === "responsive" ? { resizedFrom: width < 1024 ? 1440 : 390 } : {}) });
    }
  }
  return value;
}
test("boundary acceptance requires usable navigation and preserves source verification", () => {
  const valid = boundaryReport();
  assert.equal(acceptsBoundary(valid), true);
  for (const mutate of [
    r => { r.version = 3; },
    r => { r.inventory.states[1].returnState = "missing"; },
    r => { r.inventory.states[1].originatingControl = "missing"; },
    r => { r.inventory.states[1].destination = ""; },
    r => { r.inventory.states[1].kind = "skip"; },
    r => { r.inventory.states.push(r.inventory.states[1]); },
    r => { r.inventory.states.shift(); },
    r => { r.scenarios[0].target = "unknown"; },
    r => { r.scenarios = r.scenarios.filter(s => s.category !== "visual"); },
    r => { r.scenarios = r.scenarios.filter(s => !(s.target === "return" && s.category === "keyboard")); },
    r => { r.scenarios = r.scenarios.filter(s => !(s.target === "outside" && s.category === "responsive")); },
    r => { r.scenarios.find(s => s.target === "outside").problems.push("Horizontal page overflow"); },
    r => { r.scenarios.find(s => s.target === "outside").evidence = []; },
  ]) {
    const broken = structuredClone(valid); mutate(broken);
    assert.equal(acceptsBoundary(broken), false, mutate.toString());
  }
});

test("boundary browser checks allow no reference and catch broken returns and overflow", {skip:process.env.PROTO_BROWSER_TEST!=="1"}, async t => {
  const folder=mkdtempSync(join(tmpdir(),"proto-boundary-"));
  t.after(()=>rmSync(folder,{recursive:true,force:true}));
  const html=`<html><head><link rel="icon" href="data:,"></head><body><main></main><script>
  function render(){const outside=new URLSearchParams(location.search).has('outside');
    document.querySelector('main').innerHTML=outside?'<section><p>Outside screen</p><button id="return">Return</button></section>':'<button id="menu">Open destination</button>';
    document.querySelector('button').onclick=()=>{history.pushState({},'',outside?'/':'/?outside=1');render()};}
  render();parent.postMessage({type:'hello'},'*');</script></body></html>`;
  writeFileSync(join(folder,"index.html"),html);
  const server=await serveBuild(folder);t.after(()=>server.close());
  const inventory=boundaryReport().inventory;
  const boundary={target:"outside",path:"/?outside=1",assertion:"!!document.querySelector('#return')"};
  writeFileSync(join(folder,"prototype.json"),JSON.stringify({states:inventory.states.filter(state=>state.kind==="source").map(state=>({id:state.id}))}));
  const report=await verifyBuild(folder,{
    inventory, responsiveCss:{sourceUrl:inventory.sourceUrl,breakpoints:[]},
    scenarios:[{...boundary,id:"boundary-responsive",category:"responsive"}],
  },boundaryScreen,join(folder,"report"));
  assert.equal(report.version,4);
  assert.equal(report.scenarios.length,widthsFor(inventory).length);
  assert.ok(report.scenarios.every(s=>s.outcome==="passed" && s.evidence.length===1));
  const run=(scenario,width=320)=>runScenario(server.url,scenario,join(folder,"evidence.png"),{width,height:900},undefined,{},inventory);
  for(const width of widthsFor(inventory)) assert.deepEqual(await run({...boundary,category:"responsive"},width),[]);
  assert.deepEqual(await run({...boundary,category:"state"}),[]);
  const back={target:"return",path:"/?outside=1",category:"interaction",steps:[{kind:"click",selector:"#return"}],assertion:"!!document.querySelector('#menu') && location.search === ''"};
  assert.deepEqual(await run(back),[]);
  assert.deepEqual(await run({...back,category:"keyboard",steps:[{kind:"key",key:"Tab"},{kind:"key",key:"Enter"}]}),[]);
  assert.deepEqual(await run({category:"keyboard",target:"menu",steps:[{kind:"key",key:"Tab"},{kind:"key",key:"Enter"}],assertion:boundary.assertion}),[]);
  assert.deepEqual(await run({category:"interaction",target:"menu",steps:[{kind:"click",selector:"#menu"}],assertion:boundary.assertion}),[]);
  const source=await run({category:"responsive",target:"default",assertion:"!!document.querySelector('#menu')"});
  assert.ok(source.includes("Missing reference screenshot"));
  writeFileSync(join(folder,"index.html"),html.replace("history.pushState({},'',outside?'/':'/?outside=1');render()","if(!outside){history.pushState({},'','/?outside=1');render()}"));
  assert.ok((await run(back)).some(p=>p.includes("Assertion timed out")));
  writeFileSync(join(folder,"index.html"),html.replace('<section>','<section style="width:2000px">'));
  assert.ok((await run({...boundary,category:"responsive"})).includes("Horizontal page overflow"));
});

 test("state maps exclude boundary fallbacks while retaining product states", () => {
  const inventory = { states: [
    { id: "default", kind: "source" },
    { id: "error", kind: "source" },
    { id: "outside", kind: "prototype-boundary" },
  ] };
  assert.doesNotThrow(() => validateMapStates({ states: [{ id: "default" }, { id: "error" }] }, inventory));
  assert.throws(() => validateMapStates({ states: [{ id: "outside", title: "Not included" }] }, inventory), /must not appear/);
  assert.throws(() => validateMapStates({ states: [{ id: "unknown" }] }, inventory), /Missing declared state/);
});
