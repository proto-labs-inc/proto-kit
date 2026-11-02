import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { headlessPage } from "./cdp/headless.mjs";
import { isWrite, tryControl } from "./try-control.mjs";

test("only requests that cannot change data reach the real site", () => {
  for (const method of ["GET", "head", "OPTIONS"]) assert.equal(isWrite(method), false);
  for (const method of ["POST", "put", "PATCH", "DELETE"]) assert.equal(isWrite(method), true);
});

const PAGE = `<!doctype html><body>
<button aria-haspopup="menu" aria-expanded="false" id="regions">Region</button>
<button id="save">Save</button>
<script>
  let saves = 0;
  regions.addEventListener("pointerdown", () => {
    regions.setAttribute("aria-expanded", "true");
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.innerHTML = '<div role="menuitem">East US</div><div role="menuitem">Frankfurt</div>';
    document.body.append(menu);
  });
  save.addEventListener("click", () => fetch("/save", { method: "POST" }).then(() => saves++, () => {}));
</script></body>`;

test("trying a control reports what opened and blocks what it would write", { skip: process.env.PROTO_BROWSER_TEST !== "1" }, async () => {
  const writes = [];
  const server = createServer((request, response) => {
    if (request.method !== "GET") writes.push(request.url);
    response.setHeader("content-type", "text/html");
    response.end(PAGE);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const opened = await headlessPage(`http://127.0.0.1:${server.address().port}/`, { width: 800, height: 600 });
  const { page } = opened;
  try {
    const menu = await tryControl(page, { label: "Region" });
    assert.equal(menu.clicked, "Region");
    assert.deepEqual(menu.opened.map(item => item.role), ["menu"]);
    assert.match(menu.opened[0].label, /East US/);
    assert.ok(menu.changed.some(change => change.attribute === "aria-expanded" && change.after === "true"));

    const save = await tryControl(page, { label: "Save" });
    assert.deepEqual(save.blocked.map(request => request.method), ["POST"]);
    assert.deepEqual(writes, [], "the site never received the write");
  } finally {
    await opened.close();
    server.close();
  }
});
