import { test } from "node:test";
import assert from "node:assert/strict";
import { iconContentType } from "./codebase-icon.mjs";

test("an icon's type is read from its bytes", () => {
  assert.equal(iconContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "image/png");
  assert.equal(iconContentType(Buffer.from([0, 0, 1, 0, 1, 0])), "image/x-icon");
  assert.equal(iconContentType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
  assert.equal(
    iconContentType(Buffer.from('﻿<?xml version="1.0"?>\n<!-- logo -->\n<svg viewBox="0 0 1 1"></svg>')),
    "image/svg+xml",
  );
});

test("anything the switcher cannot draw has no type", () => {
  assert.equal(iconContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), null); // jpeg
  assert.equal(iconContentType(Buffer.from("<!doctype html><html></html>")), null); // a 404 page
  assert.equal(iconContentType(Buffer.alloc(0)), null);
});
