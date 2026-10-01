import assert from "node:assert/strict";
import { test } from "node:test";
import { visualStateDiffers, withoutNoopHovers } from "./snapshot.mjs";

function node(extra = {}) {
  return {
    tag: "button",
    parent: -1,
    attrs: { class: "button", "aria-label": "Save" },
    children: [{ text: "Save" }],
    style: {
      display: "inline-block",
      color: "rgb(0, 0, 0)",
      "background-color": "rgb(255, 255, 255)",
      "border-top-style": "solid",
      "border-top-width": "1px",
      "border-top-color": "rgb(0, 0, 0)",
      cursor: "pointer",
      transition: "background-color 0.2s",
    },
    pseudo: {},
    rect: [10, 20, 80, 32],
    value: null,
    picture: null,
    ...extra,
  };
}

const instance = (state, nodes = [node()]) => ({ state, nodes });

test("paint and layout changes are visible hover differences", () => {
  const rest = instance({ name: "Default" });
  const painted = instance({ name: "Hover", force: "hover" }, [node({
    style: { ...rest.nodes[0].style, "background-color": "rgb(0, 0, 0)", color: "rgb(255, 255, 255)", "box-shadow": "rgb(0, 0, 0) 0px 2px 4px" },
  })]);
  const moved = instance({ name: "Hover", force: "hover" }, [node({ rect: [10, 20, 82, 32] })]);
  assert.equal(visualStateDiffers(rest, painted), true);
  assert.equal(visualStateDiffers(rest, moved), true);
});

test("descendant and pseudo-element changes are visible", () => {
  const child = node({ tag: "span", parent: 0, attrs: {}, children: [{ text: "More" }], rect: [20, 20, 30, 20] });
  const root = node({ children: [{ text: "Save" }, { node: 1 }] });
  const rest = instance({ name: "Default" }, [root, child]);
  const descendant = structuredClone(rest);
  descendant.nodes[1].style.opacity = "0.5";
  const pseudo = structuredClone(rest);
  pseudo.nodes[0].pseudo["::after"] = { content: '"!"', color: "rgb(255, 0, 0)", display: "inline" };
  const pseudoSize = structuredClone(pseudo);
  pseudoSize.nodes[0].pseudo["::after"].width = "20px";
  assert.equal(visualStateDiffers(rest, descendant), true);
  assert.equal(visualStateDiffers(rest, pseudo), true);
  assert.equal(visualStateDiffers(pseudo, pseudoSize), true);
});

test("image source changes are visible", () => {
  const rest = instance({ name: "Default" }, [node({ tag: "img", attrs: { src: "rest.png" }, children: [], picture: { kind: "img", src: "rest.png" } })]);
  const held = instance({ name: "Hover", force: "hover" }, [node({ tag: "img", attrs: { src: "hover.png" }, children: [], picture: { kind: "img", src: "hover.png" } })]);
  assert.equal(visualStateDiffers(rest, held), true);
});

test("cursor, transition, pointer-event, class, and aria changes are ignored", () => {
  const rest = instance({ name: "Default" });
  const held = structuredClone(rest);
  held.nodes[0].style.cursor = "help";
  held.nodes[0].style.transition = "all 1s";
  held.nodes[0].style["pointer-events"] = "none";
  held.nodes[0].attrs.class = "button hovered";
  held.nodes[0].attrs["aria-expanded"] = "true";
  assert.equal(visualStateDiffers(rest, held), false);
});

test("no-op hover states are pruned without changing focus or real hover states", () => {
  const rest = instance({ name: "Default" });
  const noop = instance({ name: "Hover", force: "hover" });
  const focus = instance({ name: "Focus", force: "focus-visible" });
  const hover = instance({ name: "Primary hover", force: "hover" }, [node({
    style: { ...rest.nodes[0].style, color: "rgb(255, 0, 0)" },
  })]);
  assert.deepEqual(withoutNoopHovers([rest, noop, focus, hover]).map((item) => item.state.name), ["Default", "Focus", "Primary hover"]);
});

test("a hover is kept when the real pointer contaminated the resting read", () => {
  const rest = { ...instance({ name: "Default" }), pointerHovered: true };
  const hover = instance({ name: "Hover", force: "hover" });
  assert.deepEqual(withoutNoopHovers([rest, hover]).map((item) => item.state.name), ["Default", "Hover"]);
});
