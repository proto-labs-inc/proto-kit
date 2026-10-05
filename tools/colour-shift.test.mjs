import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePng } from "./cdp/png.mjs";
import { colourShift } from "./colour-shift.mjs";
import { blame, colourFinding, compare, pairNodes, sameValuesMeaning } from "./explain-diff.mjs";
import { positional } from "./live-selector.mjs";

// A 97 x 34 button as both captures drew it in the Calibre-Web run: a
// fill, a one-pixel border a shade darker, and a white label. The
// product's window drew Bootstrap's rgb(51, 122, 183) as
// rgb(45, 111, 174) through its screen's colour profile.
function button({ fill, border, text = [255, 255, 255], dx = 0, width = 97, height = 34 }) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      // The label: a band of white strokes in the middle, moved by dx.
      const label = y >= 12 && y < 22 && x - dx >= 20 && x - dx < 76 && (x - dx) % 3 === 0;
      const c = edge ? border : label ? text : fill;
      data.set([...c, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}
const LIVE = { fill: [45, 111, 174], border: [41, 98, 154] };
const OURS = { fill: [51, 122, 183], border: [46, 109, 164] };

test("a box drawn another colour is one uniform shift, named by its two colours", () => {
  const shift = colourShift(button(LIVE), button(OURS));
  assert.ok(shift);
  assert.deepEqual(shift.live, [45, 111, 174]);
  assert.deepEqual(shift.ours, [51, 122, 183]);
  assert.deepEqual(shift.delta, [-6, -11, -9]);
  assert.equal(shift.uniform, true);
  assert.ok(shift.share > 0.6);
  assert.ok(shift.explained > 0.9, `explained ${shift.explained}`);
  // The border moved the same way; the white label did not move at all.
  assert.deepEqual(shift.pairs[1], { ours: [46, 109, 164], live: [41, 98, 154], share: shift.pairs[1].share, agree: 1 });
});

test("the same colours in another place, or the same picture, are no colour shift", () => {
  assert.equal(colourShift(button({ ...OURS, dx: 1 }), button(OURS)), null);
  assert.equal(colourShift(button(OURS), button(OURS)), null);
  // A faint difference under the diff's threshold is not one either.
  assert.equal(colourShift(button({ fill: [53, 124, 185], border: OURS.border }), button(OURS)), null);
});

test("a shift is found inside a region when the rest of the box agrees", () => {
  const live = button(OURS);
  const ours = button(OURS);
  // Only the left half of the live picture is darker.
  for (let y = 1; y < 33; y++) for (let x = 1; x < 48; x++) if (live.data[(y * 97 + x) * 4] === 51) live.data.set([45, 111, 174], (y * 97 + x) * 4);
  assert.equal(colourShift(live, ours, [60, 0, 37, 34]), null);
  const left = colourShift(live, ours, [0, 0, 48, 34]);
  assert.deepEqual(left?.live, [45, 111, 174]);
});

// ---- the diagnosis explain-diff builds on it ----

const BLUE = "rgb(51, 122, 183)";
function node(i, { tag = "button", parent = -1, text = "", style = {}, drawn = {}, attrs = {}, rect = [0, 0, 97, 34] } = {}) {
  return { i, tag, svg: false, parent, attrs, text, style, colours: drawn, drawn, pseudo: {}, references: [], image: null, value: null, rect };
}
const baseStyle = { "background-color": BLUE, color: "rgb(255, 255, 255)", display: "inline-block", "margin-bottom": "0px", "transition-duration": "0s", "transition-property": "all", "border-top-width": "1px", "border-top-style": "solid", "border-top-color": "rgb(46, 109, 164)" };
const side = (style = {}, drawn = {}, extra = {}) => ({
  nodes: [node(0, { text: "Download", style: { ...baseStyle, ...style }, drawn: { "background-color": [51, 122, 183, 255], color: [255, 255, 255, 255], "border-top-color": [46, 109, 164, 255], ...drawn } })],
  fonts: new Map(),
  backdrop: [242, 242, 242, 255],
  effects: [],
  state: { hover: false, focus: false, active: false, link: false, focusedWindow: false },
  running: 0,
  ...extra,
});
function pass(livePicture, oursPicture) {
  const dir = mkdtempSync(join(tmpdir(), "colour-shift-"));
  writeFileSync(join(dir, "1-live.png"), encodePng(livePicture));
  writeFileSync(join(dir, "1.png"), encodePng(oursPicture));
  return { live: join(dir, "1-live.png"), screenshot: join(dir, "1.png"), clusters: [{ cssRect: [0, 0, 97, 34], px: 2924 }], display: { dpr: 1, colorProfile: "srgb" }, mismatch: 2924, shifted: { mismatch: 3066 } };
}

test("both sides computing the same colour that the product's picture shows as another is a capture difference, not the component's", () => {
  const live = side();
  const mine = side();
  const p = pass(button(LIVE), button(OURS));
  const finding = colourFinding(live, mine, p, pairNodes(live, mine));
  assert.equal(finding.cause, "capture");
  assert.match(finding.line, /rgb\(45, 111, 174\) in the product's picture, rgb\(51, 122, 183\) in ours/);
  assert.match(finding.line, /root <button> background-color computes rgb\(51, 122, 183\) on both sides/);
  assert.match(finding.line, /colour capture difference/);
  const b = blame(live, mine, [], p, finding);
  assert.equal(b.where, "outside");
  assert.match(b.reason, /colour profile/);
});

test("a colour the product's own value draws is named with the value to write", () => {
  const live = side({ "background-color": "rgb(45, 111, 174)" }, { "background-color": [45, 111, 174, 255] });
  const mine = side();
  const p = pass(button(LIVE), button(OURS));
  const finding = colourFinding(live, mine, p, pairNodes(live, mine));
  assert.equal(finding.cause, "value");
  assert.match(finding.line, /background-color is rgb\(45, 111, 174\) in the product, rgb\(51, 122, 183\) here/);
  assert.equal(blame(live, mine, compare(live, mine, p.clusters), p, finding).where, "item");
});

test("an opacity or filter around the product's element is told as the cause", () => {
  const live = side({}, {}, { effects: [{ tag: "div", root: false, values: ["filter brightness(0.9)"] }] });
  const mine = side();
  const finding = colourFinding(live, mine, pass(button(LIVE), button(OURS)), pairNodes(live, mine));
  assert.equal(finding.cause, "effect");
  assert.match(finding.line, /<div> has filter brightness\(0.9\)/);
});

test("root margins, inert attributes and a blockified display are not offered as fixes", () => {
  const live = side({ "margin-bottom": "5px", display: "block" });
  live.nodes[0].attrs = { value: "", action: "/search", disabled: "" };
  const mine = side();
  const differences = compare(live, mine, [{ cssRect: [0, 0, 97, 34], px: 10 }]);
  assert.deepEqual(differences.map((d) => d.property), ["disabled"]);
  // A child's margin that moved nothing is dropped; one that moved it stays (as its box).
  const withChild = (margin, rect) => {
    const s = side();
    s.nodes.push(node(1, { tag: "span", parent: 0, style: { "margin-left": margin }, rect }));
    return s;
  };
  assert.deepEqual(compare(withChild("4px", [4, 0, 20, 20]), withChild("0px", [4, 0, 20, 20]), []).map((d) => d.property), []);
  assert.deepEqual(compare(withChild("4px", [4, 0, 20, 20]), withChild("0px", [0, 0, 20, 20]), []).map((d) => d.property), ["box", "margin-left"]);
});

test("identical values with differing pixels say what that leaves", () => {
  const state = { name: "Default", live: { selector: "#Download" } };
  const live = side({ "transition-duration": "0.2s", "transition-property": "background-color" }, {}, { state: { hover: true, focus: false, active: false, link: true, focusedWindow: false } });
  const meaning = sameValuesMeaning(live, side(), state, null);
  assert.ok(meaning.some((m) => /:hover/.test(m)));
  assert.ok(meaning.some((m) => /transition \(background-color over 0.2s\)/.test(m)));
  assert.ok(meaning.some((m) => /:visited/.test(m)));
  // With nothing on the page to blame, it says so instead of a bare message.
  assert.match(sameValuesMeaning(side(), side(), state, null)[0], /antialiasing, subpixel text or a colour profile/);
});

test("a selector is positional when it names elements by their place", () => {
  assert.equal(positional("body:nth-of-type(1) > div:nth-of-type(3) > a:nth-of-type(1)"), true);
  assert.equal(positional("#Download"), false);
  assert.equal(positional("ul > li:nth-child(2)"), true);
});
