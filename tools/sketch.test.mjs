import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChanges } from "./sketch.mjs";

const base = {
  frame: "desktop",
  root: { t: "row", id: "page", children: [
    { t: "nav", id: "nav", items: ["Home"] },
    { t: "col", id: "main", children: [{ t: "text", id: "title", text: "Home" }, { t: "chart", id: "usage" }] },
  ] },
};

test("a direction written as changes is the base with only those parts changed", () => {
  const card = { t: "row", id: "health", hl: true, children: [] };
  const out = applyChanges(base, [
    { after: "title", add: card },
    { set: "title", to: { text: "My project" } },
    { remove: "nav" },
  ]);
  assert.deepEqual(out.root.children.map((c) => c.id), ["main"]);
  assert.deepEqual(out.root.children[0].children.map((c) => c.id), ["title", "health", "usage"]);
  assert.equal(out.root.children[0].children[0].text, "My project");
  assert.equal(base.root.children.length, 2, "the base itself is untouched");
});

test("a change naming a part the base does not have says which ids it does have", () => {
  assert.throws(() => applyChanges(base, [{ replace: "hero", with: { t: "text" } }]), /no part with id "hero".*page, nav, main, title, usage/);
});

test("replace and into put parts where they are named", () => {
  const out = applyChanges(base, [{ replace: "usage", with: { t: "table", id: "t", cols: ["a"] } }, { into: "main", add: { t: "button", label: "Go" }, at: 0 }]);
  assert.deepEqual(out.root.children[1].children.map((c) => c.t), ["button", "text", "table"]);
});

test("a take written as changes can itself be what a moment starts from", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { wireframeIn } = await import("./sketch.mjs");
  const dir = mkdtempSync(join(tmpdir(), "sketch-"));
  writeFileSync(join(dir, "base.json"), JSON.stringify(base));
  writeFileSync(join(dir, "calm.json"), JSON.stringify({ type: "direction", id: "calm", wireframe: { from: "base", changes: [{ remove: "nav" }] } }));
  const drawing = wireframeIn(dir, "calm");
  assert.deepEqual(drawing.root.children.map((c) => c.id), ["main"]);
});
