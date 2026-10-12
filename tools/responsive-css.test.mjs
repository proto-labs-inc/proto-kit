import test from "node:test";
import assert from "node:assert/strict";
import { mediaBreakpoints, discoverResponsiveCss } from "./responsive-css.mjs";
import { widthsFor } from "./screen-verification.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { evaluate } from "./cdp/cdp.mjs";

test("compiled media expressions retain custom, rem and fractional boundaries", () => {
  const found = mediaBreakpoints([
    {text:"(width >= 53rem)", mediaList:[{expressions:[{feature:"width",value:53,unit:"rem",computedLength:848}]}]},
    {text:"(max-width: 767.98px)", mediaList:[{expressions:[{feature:"max-width",value:767.98,unit:"px"}]}]},
    {text:"(orientation: portrait)", mediaList:[]},
  ]);
  assert.deepEqual(found.breakpoints,[767.98,848]);
  assert.deepEqual(found.unresolved,["(orientation: portrait)"]);
  assert.deepEqual(widthsFor({breakpoints:[]}),[320,880,1440]);
  assert.deepEqual(widthsFor({breakpoints:[800]}),[320,560,799,800,801,1120,1440]);
  assert.ok(widthsFor(found).includes(767));
  assert.ok(widthsFor(found).includes(768));
  assert.ok(!widthsFor({breakpoints:[800]}).includes(1024));
});

test("browser reads nested Tailwind-style CSS, adopted sheets and container queries", {skip:process.env.PROTO_BROWSER_TEST!=="1"}, async () => {
  const opened = await headlessPage("about:blank", {width:1200,height:900});
  try {
    await evaluate(opened.page, `(()=>{
      document.documentElement.innerHTML='<head><style>html{font-size:20px}@layer utilities { @media (width >= 53rem) { .custom {display:grid} } } @media (max-width:767.98px) { .custom {display:block} } @container cards (width > 400px) { .card {display:flex} }</style></head><body><div class="custom">Example</div></body>';
      const sheet=new CSSStyleSheet();sheet.replaceSync('@media (min-width:1101px){.custom{color:red}}');document.adoptedStyleSheets=[sheet];
    })()`);
    const report = await discoverResponsiveCss(opened.page);
    assert.ok(report.breakpoints.includes(848), JSON.stringify(report));
    assert.ok(report.breakpoints.includes(767.98), JSON.stringify(report));
    assert.ok(report.breakpoints.includes(1101), JSON.stringify(report));
    assert.equal(report.containerQueries.length,1);
    assert.equal(report.containerQueries[0].name,"cards");
    assert.ok(report.containerQueries[0].condition.includes("400px"));
    assert.ok(!report.breakpoints.includes(400));
    assert.deepEqual(report.warnings,[]);
  } finally { await opened.close(); }
});
