import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyManagedBuild } from "./managed-preview.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { evaluate } from "./cdp/cdp.mjs";
import { stableShot, VIEWPORT, FONTS_LOADED } from "./cdp/capture.mjs";

const [workspace, url, initialStateJson] = process.argv.slice(2);
if (!workspace || !url || !initialStateJson) throw new Error("usage: check-managed-starter.mjs <workspace> <managed-url> <initial-state-json>");
const initialState = JSON.parse(initialStateJson);
await verifyManagedBuild(join(workspace, "dist"), url);
const manifest = JSON.parse(readFileSync(join(workspace, "public/prototype.json")));
const opened = await headlessPage(url, { width: 1440, height: 900 });
const errors = [];
opened.page.on("Runtime.exceptionThrown", event => errors.push(event.exceptionDetails?.text || "Runtime exception"));
try {
  await opened.page.send("Runtime.enable");
  const loaded = opened.page.once("Page.loadEventFired");
  await opened.page.send("Page.reload");
  await Promise.race([loaded, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Managed preview reload timed out")), 20000); timer.unref(); })]);
  const picture = join(workspace, ".proto-smoke.png");
  await stableShot(opened.page, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, picture);
  const result = JSON.parse(await evaluate(opened.page, `JSON.stringify({text:document.body.innerText.trim().length, markers:document.querySelectorAll('[data-proto-id]').length,url:location.href})`));
  if (!result.text || !result.markers || errors.length) throw new Error(`Starter smoke failed: ${JSON.stringify({result, errors})}`);
  for (const [key, value] of Object.entries(initialState)) {
    if (new URL(result.url).searchParams.get(key) !== value) throw new Error(`Initial state mismatch: ${key}`);
  }
  if (manifest.variantSets?.length) throw new Error("New prototype must have no variant sets");
  console.log(JSON.stringify({ status: "passed", picture, ...result }));
} finally { await opened.close(); }
