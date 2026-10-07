import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { elementSpan, nestedMarkers, readableMarkup } from "./markup.mjs";
import { changedMarkers } from "./views.mjs";

const tool = fileURLToPath(new URL("./variant-set.mjs", import.meta.url));
const PAGE =
  '<header data-pf="1" data-proto-id="header"><a class="text-sm" data-pf="2" data-proto-id="project-switcher"><span data-pf="3">Prooject</span></a></header>' +
  '<main data-pf="4"><div class="rounded-lg border" data-pf="5" data-proto-id="paused-notice"><div data-pf="6"><p data-pf="7">Project is paused</p></div><img src="a.png" data-pf="8"></div></main>';

/** A frozen workspace under a codebase folder, as scaffold and freeze leave it. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "variant-set-"));
  writeFileSync(join(root, "codebase.json"), JSON.stringify({ source: { path: "/repo/acme" } }));
  const ws = join(root, "prototypes", "notice");
  mkdirSync(join(ws, "public"), { recursive: true });
  mkdirSync(join(ws, "src", "frozen"), { recursive: true });
  writeFileSync(join(ws, "public", "prototype.json"), JSON.stringify({ schemaVersion: 2, name: "notice", states: [], variantSets: [] }));
  writeFileSync(join(ws, "src", "frozen", "page.html"), PAGE);
  return ws;
}
const run = (ws, ...args) => spawnSync(process.execPath, [tool, ws, "paused-notice", "--title", "Paused state", "--variants", "badge=Badge|a badge;dot=Dot|a dot", "--default", "badge", "--baseline", "current=Current", "--no-send", ...args], { encoding: "utf8" });

test("references are published in the manifest and routed to the relevant builder briefs", () => {
  const ws = workspace();
  const references = [
    { app: "Badge example", url: "https://mobbin.com/example-badge", image: "references/badge.webp", note: "Group status with its action", variant: "badge" },
    { app: "Dot example", url: "https://mobbin.com/example-dot", image: "references/dot.webp", note: "Compact status", variant: "dot" },
    { app: "Shared example", url: "https://mobbin.com/example-shared", image: "references/shared.webp", note: "Keep the hierarchy" },
  ];
  const file = join(ws, "references.json");
  writeFileSync(file, JSON.stringify(references));
  const res = run(ws, "--references", file);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, "public", "prototype.json"))).variantSets[0].references, references);
  const out = JSON.parse(res.stdout);
  for (const v of out.variants) {
    const brief = readFileSync(v.brief, "utf8");
    assert.ok(brief.includes(join(ws, "public", "references", `${v.id}.webp`)));
    assert.ok(brief.includes("https://mobbin.com/example-shared"));
    assert.ok(brief.includes(references.find(ref => ref.variant === v.id).note));
    assert.ok(!brief.includes(`example-${v.id === "badge" ? "dot" : "badge"}`));
  }
});

test("invalid references are refused before creating a set or source files", () => {
  for (const references of [{}, [{ variant: "missing" }]]) {
    const ws = workspace();
    const file = join(ws, "references.json");
    const manifest = join(ws, "public", "prototype.json");
    const before = readFileSync(manifest, "utf8");
    writeFileSync(file, JSON.stringify(references));
    const res = run(ws, "--references", file);
    assert.equal(res.status, 1);
    assert.equal(readFileSync(manifest, "utf8"), before);
    assert.equal(existsSync(join(ws, "src", "variants")), false);
  }
});

test("a set with two regions writes one module per variant with a component per region, a switch per region, and the manifest's regions", () => {
  const ws = workspace();
  const res = run(ws, "--regions", "paused-notice,project-switcher");
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.regions, ["paused-notice", "project-switcher"]);
  assert.match(out.switch.usage, /"paused-notice": <PausedNoticeVariants baseline=\{<FrozenHtml marker="paused-notice" \/>\} \/>, "project-switcher": <ProjectSwitcherVariants baseline=\{<FrozenHtml marker="project-switcher" \/>\} \/>/);
  const variant = readFileSync(join(ws, "src", "variants", "paused-notice", "badge.tsx"), "utf8");
  assert.match(variant, /export const useShared = createVariantStore\(\{\}\)/);
  assert.match(variant, /export function PausedNotice\(/);
  assert.match(variant, /export function ProjectSwitcher\(/);
  assert.match(variant, /data-proto-id="project-switcher"/);
  const index = readFileSync(join(ws, "src", "variants", "paused-notice", "index.tsx"), "utf8");
  assert.equal(index.match(/useVariant\("paused-notice"/g)?.length, 2, "both switches read the one choice");
  assert.match(index, /export function ProjectSwitcherVariants\(/);
  assert.match(index, /case "dot":\n      return <DotVariant\.ProjectSwitcher/);
  assert.ok(existsSync(join(ws, "src", "variants", "store.ts")));
  const manifest = JSON.parse(readFileSync(join(ws, "public", "prototype.json"), "utf8"));
  assert.deepEqual(manifest.variantSets[0].regions, ["paused-notice", "project-switcher"]);
  const brief = readFileSync(out.variants[0].brief, "utf8");
  assert.match(brief, /`ProjectSwitcher` replaces the frozen element marked `project-switcher`/);
  assert.match(brief, /useShared/);
  assert.match(brief, /\/repo\/acme/);
  const markup = readFileSync(brief.match(/its markup, a tag per line, is `([^`]+project-switcher\.html)`/)[1], "utf8");
  assert.match(markup, /^<a class="text-sm"[^\n]*>\n  <span/);
});

test("one region writes the set as before: a default export per variant and one switch", () => {
  const ws = workspace();
  const res = run(ws);
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(join(ws, "src", "variants", "paused-notice", "badge.tsx"), "utf8"), /export default function Badge\(/);
  assert.equal(existsSync(join(ws, "src", "variants", "store.ts")), false);
  assert.deepEqual(JSON.parse(readFileSync(join(ws, "public", "prototype.json"), "utf8")).variantSets[0].regions, ["paused-notice"]);
});

test("a region with no marker, or one inside another, is refused before anything is written", () => {
  const ws = workspace();
  const manifestPath = join(ws, "public", "prototype.json");
  const before = readFileSync(manifestPath, "utf8");
  const missing = run(ws, "--regions", "paused-notice,org-switcher");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no element marked "org-switcher".*add data-proto-id="org-switcher"/);
  assert.equal(readFileSync(manifestPath, "utf8"), before);
  assert.equal(existsSync(join(ws, "src", "variants")), false);
  const nested = run(ws.replace(/notice$/, "notice"), "--regions", "paused-notice,header", "--title", "x");
  assert.equal(nested.status, 0, "header and the notice are siblings");
  const beforeNested = readFileSync(manifestPath, "utf8");
  const inside = spawnSync(process.execPath, [tool, ws, "header", "--title", "t", "--variants", "a=A|", "--default", "a", "--regions", "header,project-switcher", "--no-send"], { encoding: "utf8" });
  assert.equal(inside.status, 1);
  assert.match(inside.stderr, /"project-switcher" is inside "header"/);
  assert.equal(existsSync(join(ws, "src", "variants", "header")), false);
  assert.equal(readFileSync(manifestPath, "utf8"), beforeNested);
});

test("the markup helper finds a marked element's extent, its nesting, and lays it out", () => {
  const span = elementSpan(PAGE, "paused-notice");
  assert.ok(PAGE.slice(span.start, span.end).endsWith('<img src="a.png" data-pf="8"></div>'));
  assert.deepEqual(nestedMarkers(PAGE, ["header", "project-switcher", "paused-notice"]), [["header", "project-switcher"]]);
  assert.equal(readableMarkup('<div a="1"><p>Hi</p><br></div>'), '<div a="1">\n  <p>\n    Hi\n  </p>\n  <br>\n</div>\n');
});

test("a check counts every region of every set as changed", () => {
  const manifest = { variantSets: [{ component: "paused-notice", regions: ["paused-notice", "project-switcher"] }, { component: "usage" }] };
  assert.deepEqual([...changedMarkers(manifest, ["sidebar "])], ["sidebar", "paused-notice", "project-switcher", "usage"]);
});

for (const keepSwitch of [true, false]) {
  test(`duplicate multi-region creation preserves the manifest and variant files (switch present: ${keepSwitch})`, () => {
    const ws = workspace();
    const first = run(ws, "--regions", "paused-notice,project-switcher");
    assert.equal(first.status, 0, first.stderr);
    const dir = join(ws, "src", "variants", "paused-notice");
    const variantPath = join(dir, "badge.tsx");
    writeFileSync(variantPath, "// custom variant content\n");
    const switchPath = join(dir, "index.tsx");
    const originalSwitch = readFileSync(switchPath, "utf8");
    if (!keepSwitch) rmSync(switchPath);
    const manifestPath = join(ws, "public", "prototype.json");
    const before = readFileSync(manifestPath, "utf8");
    const duplicate = run(ws, "--regions", "paused-notice,project-switcher", "--title", "Replacement");
    assert.equal(duplicate.status, 1);
    assert.match(duplicate.stderr, /already/);
    assert.equal(readFileSync(manifestPath, "utf8"), before);
    assert.equal(readFileSync(variantPath, "utf8"), "// custom variant content\n");
    if (keepSwitch) assert.equal(readFileSync(switchPath, "utf8"), originalSwitch);
    else assert.equal(existsSync(switchPath), false);
  });
}
