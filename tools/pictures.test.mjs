import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSIDE, inSvgPicture, localStyleImages, writePictures, writeStyleImages } from "./pictures.mjs";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" style="fill: none"><path d="M0 0h4v4z" style="fill: url(&quot;#g&quot;)"/></svg>';
const png = "data:image/png;base64," + Buffer.from("not really a png").toString("base64");

function node(tag, parent, extra = {}) {
  return { tag, parent, attrs: {}, children: [], style: {}, pseudo: {}, rect: [0, 0, 10, 10], ...extra };
}

test("an svg's elements are drawn by its picture, not the stylesheet", () => {
  const nodes = [node("div", -1), node("svg", 0, { svg: true, picture: { kind: "svg", markup: svg } }), node("g", 1, { svg: true }), node("path", 2, { svg: true }), node("span", 0)];
  assert.deepEqual(nodes.map((_, i) => inSvgPicture(nodes, i)), [false, false, true, true, false]);
});

test("the component's own <svg> holds the picture's inner markup", () => {
  const inside = new Function(`${INSIDE.replace(": string", "")} return inside;`)();
  assert.equal(inside(svg), '<path d="M0 0h4v4z" style="fill: url(&quot;#g&quot;)"/>');
});

test("pictures are written once each, from the looks and not the held states", () => {
  const folder = mkdtempSync(join(tmpdir(), "pictures-"));
  const look = { state: { name: "Default" }, nodes: [node("svg", -1, { picture: { kind: "svg", markup: svg } }), node("canvas", -1, { picture: { kind: "canvas", data: png } })] };
  const again = { state: { name: "Other" }, nodes: [node("svg", -1, { picture: { kind: "svg", markup: svg } })] };
  const held = { state: { name: "Hover", force: "hover" }, nodes: [node("svg", -1, { picture: { kind: "svg", markup: svg.replace("none", "red") } })] };
  const { svgs, canvases } = writePictures(folder, [look, again, held]);
  assert.equal(svgs.size, 1);
  assert.equal(canvases.size, 1);
  assert.deepEqual(readdirSync(folder).sort(), ["picture1.svg", "picture2.png"]);
  assert.equal(readFileSync(join(folder, "picture1.svg"), "utf8").trim(), svg);
  assert.equal(readFileSync(join(folder, "picture2.png"), "utf8"), "not really a png");
});

test("stylesheet images become files beside the module; one that cannot be fetched keeps its address", async () => {
  const folder = mkdtempSync(join(tmpdir(), "pictures-"));
  const captured = join(folder, "captured.png");
  writeFileSync(captured, "captured");
  const bg = "https://example.com/a/hero.jpg";
  const mask = "https://example.com/mask.svg";
  const gone = "https://example.com/gone.png";
  const inst = { nodes: [node("div", -1, { style: { "background-image": `url("${bg}"), url("${gone}")`, color: `url("${bg}")` }, pseudo: { "::before": { "-webkit-mask-image": `url("${mask}")` } } })] };
  const fetched = [];
  const download = async (url, to) => {
    if (url === gone) throw new Error("404");
    fetched.push(url);
    writeFileSync(to, "downloaded");
  };
  const files = await writeStyleImages(folder, [inst], { [mask]: captured }, download);
  assert.deepEqual(fetched, [bg]);
  assert.equal(files.get(bg), "./background1.jpg");
  assert.equal(files.get(mask), "./background2.svg");
  assert.equal(files.has(gone), false);
  assert.equal(readFileSync(join(folder, "background2.svg"), "utf8"), "captured");
  const css = `.root {\n  background-image: url("${bg}"), url("${gone}");\n}\n`;
  assert.equal(localStyleImages(css, files), `.root {\n  background-image: url("./background1.jpg"), url("${gone}");\n}\n`);
});
