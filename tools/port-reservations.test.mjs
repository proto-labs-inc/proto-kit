import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);

test("simultaneous processes reserve distinct preview ports including screen workspaces", async () => {
  const root = mkdtempSync(join(tmpdir(), "proto-ports-"));
  const module = new URL("./ports.mjs", import.meta.url).href;
  const owners = [join(root, "cb/prototypes/home/public/prototype.json"), join(root, "cb/screens/work/index/1/playground/public/prototype.json")];
  for (const owner of owners) { mkdirSync(join(owner, ".."), { recursive: true }); writeFileSync(owner, "{}"); }
  const reserve = owner => exec(process.execPath, ["--input-type=module", "-e", `import { reservePort } from ${JSON.stringify(module)}; console.log(await reservePort({owner:process.argv[1], from:48000, to:48100}));`, owner], { env: { ...process.env, PROTO_HOME: root } }).then(value => Number(value.stdout.trim()));
  try {
    const [a, b] = await Promise.all(owners.map(reserve));
    assert.notEqual(a, b);
    assert.equal(await reserve(owners[0]), a);
    assert.equal(await reserve(owners[1]), b);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
