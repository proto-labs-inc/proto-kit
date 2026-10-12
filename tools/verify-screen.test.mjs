import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveBuild, runScenario, smokeBuild, validateResponsivePlan } from "./verify-screen.mjs";
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
    version: 3,
    sourceChecksum: screen.bundle_checksum,
    buildChecksum: "d".repeat(64),
    inventory: {
      sourceUrl: screen.source_url,
      capturedAt: new Date().toISOString(),
      controls: [{ id: "menu", expected: "Opens", state: "enabled" }],
      states: ["default"],
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
  const plan = { inventory: {sourceUrl:"https://source.invalid", breakpoints:[848]}, responsiveCss: {sourceUrl:"https://source.invalid",breakpoints:[848],containerQueries:[],warnings:[],unresolved:[]}, scenarios:[] };
  assert.doesNotThrow(()=>validateResponsivePlan(plan));
  assert.throws(()=>validateResponsivePlan({...plan,responsiveCss:null}),/responsive-css/);
  assert.throws(()=>validateResponsivePlan({...plan,inventory:{...plan.inventory,breakpoints:[]}}),/omits/);
  const unresolved = {...plan,responsiveCss:{...plan.responsiveCss,unresolved:['(orientation:portrait)']}};
  assert.throws(()=>validateResponsivePlan(unresolved),/unresolved/);
  assert.doesNotThrow(()=>validateResponsivePlan({...unresolved,responsiveCssReview:{'(orientation:portrait)':'Inspected source and added portrait and landscape references.'}}));
  const container = {...plan,responsiveCss:{...plan.responsiveCss,containerQueries:[{condition:'cards (width > 250px)'}]}};
  assert.throws(()=>validateResponsivePlan(container),/container-size/);
  assert.doesNotThrow(()=>validateResponsivePlan({...container,scenarios:[{category:'responsive',containerQuery:'cards (width > 250px)',steps:[{kind:'resize-container',selector:'#cards',width:250}]}]}));
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
