import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The kit's own imports belong at the top of snapshot.mjs, not in the
// source it writes for a component: there they broke the snapshot run
// (protoHome and libraryPort undefined) and every library build (a
// component importing ./ports.mjs, which the library does not have).
test("snapshot.mjs loads, and the component source it writes imports no kit tools", async () => {
  await import("./snapshot.mjs");
  const source = readFileSync(new URL("./snapshot.mjs", import.meta.url), "utf8");
  const start = source.indexOf("const tsx = `");
  const template = source.slice(start, source.indexOf("\n/**", start));
  assert.ok(start > 0, "the component template is where this test looks for it");
  assert.doesNotMatch(template, /\.\/(ports|proto-home)\.mjs/);
  const header = source.slice(0, source.indexOf("\n/**", source.indexOf("import ")));
  assert.match(header, /import \{ libraryPort \} from "\.\/ports\.mjs"/);
  assert.match(header, /import \{ protoHome \} from "\.\/proto-home\.mjs"/);
});
