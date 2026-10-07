#!/usr/bin/env node
/**
 * Clicks one control in a variant and says what changed, so the unit that
 * wrote it can check a control does what the direction says (Resume starts
 * the restore in every region, the chevron opens the menu) without a
 * browser of its own. The pictures show how a state looks; this shows
 * whether the controls lead there.
 *
 * Usage: node tools/click.mjs <workspace> --variant <set>=<id> --click "<text>" [--state <id>] [--in <region>]
 *
 * --click is the control's visible text (or aria-label), matched exactly
 * after trimming; --in limits the search to one region (its marker, and
 * its pieces marked "<region>-…"). Prints one JSON line: { clicked, state:
 * { before, after } (the preview state, from the URL), regions: [{ region,
 * before, after, changed }] (each region's text), picture } with a picture
 * of the page after the click.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOfWorkspace } from "./build-folder.mjs";
import { stableShot, FONTS_LOADED, VIEWPORT } from "./cdp/capture.mjs";
import { evaluate } from "./cdp/cdp.mjs";
import { headlessPage } from "./cdp/headless.mjs";
import { ensureDevServer } from "./dev-server.mjs";
import { launchedDisplayOr, waitForMarkers } from "./views.mjs";

const USAGE = 'usage: node tools/click.mjs <workspace> --variant <set>=<id> --click "<text>" [--state <id>] [--in <region>]';
const args = process.argv.slice(2);
const options = {};
const positional = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i].startsWith("--")) options[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const [workspace] = positional;
if (!workspace || !options.variant || !options.click || !existsSync(join(workspace, "public", "prototype.json"))) {
  console.error(USAGE);
  process.exit(1);
}
const [set, id] = options.variant.split("=");
const manifest = JSON.parse(readFileSync(join(workspace, "public", "prototype.json"), "utf8"));
const regions = manifest.variantSets?.find((s) => s.component === set)?.regions ?? [set];
const build = buildOfWorkspace(workspace);
const viewport = build?.tree?.viewport ?? manifest.viewport ?? { width: 1280, height: 800 };
const display = launchedDisplayOr(viewport);
const looksDir = join(build ? build.dir : join(workspace, ".proto-checks"), "looks");
mkdirSync(looksDir, { recursive: true });
const dev = await ensureDevServer({ workspace, logPath: join(looksDir, "..", "dev.log") });

const query = new URLSearchParams({ [`v.${set}`]: id });
if (options.state) query.set("state", options.state);
const url = `${dev.url}/?${query}`;

// Each region's text: the marked element and its pieces marked "<region>-…".
const READ = `JSON.stringify(Object.fromEntries(${JSON.stringify(regions)}.map((r) => [r, [...document.querySelectorAll('[data-proto-id=' + JSON.stringify(r) + '], [data-proto-id^=' + JSON.stringify(r + "-") + ']')].filter((e, i, all) => !all.some((o) => o !== e && o.contains(e))).map((e) => e.innerText.replace(/\\s+/g, " ").trim()).join(" | ")])))`;
const STATE = `new URLSearchParams(location.search).get("state") ?? "default"`;
const CLICK = `(() => {
  const want = ${JSON.stringify(options.click.trim())};
  const scope = ${JSON.stringify(options.in ?? null)};
  const inScope = (e) => !scope || !!e.closest('[data-proto-id=' + JSON.stringify(scope) + '], [data-proto-id^=' + JSON.stringify((scope ?? "") + "-") + ']');
  const controls = [...document.querySelectorAll("button, a, [role=button], [role=menuitem], summary, input[type=button], input[type=submit]")];
  const matches = controls.filter((e) => inScope(e) && e.getClientRects().length && ((e.innerText ?? "").trim() === want || e.getAttribute("aria-label") === want || e.value === want));
  if (matches.length === 0) return JSON.stringify({ clicked: false, why: "no visible control reads " + JSON.stringify(want) + (scope ? " in " + scope : ""), controls: controls.filter(inScope).map((e) => (e.innerText ?? e.getAttribute("aria-label") ?? "").trim()).filter(Boolean).slice(0, 20) });
  matches[0].click();
  return JSON.stringify({ clicked: true, matches: matches.length });
})()`;

const opened = await headlessPage(url, { ...viewport, display });
let out;
try {
  await waitForMarkers(opened.page);
  const before = { text: JSON.parse(await evaluate(opened.page, READ)), state: await evaluate(opened.page, STATE) };
  const clicked = JSON.parse(await evaluate(opened.page, CLICK));
  await new Promise((r) => setTimeout(r, 600));
  const after = { text: JSON.parse(await evaluate(opened.page, READ)), state: await evaluate(opened.page, STATE) };
  const picture = join(looksDir, `click--${set}-${id}--${options.click.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
  await stableShot(opened.page, `JSON.stringify([${VIEWPORT}, ${FONTS_LOADED}])`, picture);
  out = {
    ...clicked,
    state: { before: before.state, after: after.state },
    regions: regions.map((r) => ({ region: r, before: before.text[r], after: after.text[r], changed: before.text[r] !== after.text[r] })),
    picture,
  };
} finally {
  await opened.close().catch(() => {});
  dev.stop();
}
console.log(JSON.stringify(out));
process.exit(0);
