import { test } from "node:test";
import assert from "node:assert/strict";
import { findPage } from "./attach.mjs";
import { sourceUrl } from "./source-session.mjs";

test("source selection requires ownership even when a URL is unambiguous", async () => {
  const previous = process.env.PROTO_BROWSER_SESSION;
  delete process.env.PROTO_BROWSER_SESSION;
  try { await assert.rejects(findPage("https://product.example/home"), /build identity|browser-session/); }
  finally { if (previous !== undefined) process.env.PROTO_BROWSER_SESSION = previous; }
});

test("source identity preserves query and fragment and rejects incomplete selectors", () => {
  assert.equal(sourceUrl("https://product.example/home?view=two#section"), "https://product.example/home?view=two#section");
  assert.throws(() => sourceUrl("product.example/home"));
  assert.throws(() => sourceUrl("file:///tmp/home"), /http or https/);
});
