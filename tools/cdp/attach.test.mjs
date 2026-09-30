import { test } from "node:test";
import assert from "node:assert/strict";
import { findOrOpenPage, planPageAccess } from "./attach.mjs";

class FakeWebSocket {
  static methods = [];
  static urls = [];
  static evaluations = [];

  constructor(url) {
    assert.match(url, /^ws:\/\//);
    FakeWebSocket.urls.push(url);
    queueMicrotask(() => this.onopen?.());
  }

  send(raw) {
    const message = JSON.parse(raw);
    FakeWebSocket.methods.push(message.method);
    const result =
      message.method === "Target.createTarget"
        ? { targetId: "created" }
        : message.method === "Runtime.evaluate"
          ? { result: { value: FakeWebSocket.evaluations.shift() } }
          : {};
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
  }

  close() {
    this.onclose?.();
  }
}

async function withFakeBrowser(fetchImpl, run) {
  const realFetch = globalThis.fetch;
  const RealWebSocket = globalThis.WebSocket;
  FakeWebSocket.methods = [];
  FakeWebSocket.urls = [];
  FakeWebSocket.evaluations = [];
  globalThis.fetch = fetchImpl;
  globalThis.WebSocket = FakeWebSocket;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = RealWebSocket;
  }
}

test("an existing matching product tab is reused", () => {
  const pages = [
    { id: "other", url: "https://other.example/dashboard" },
    { id: "wanted", url: "https://product.example/app?view=one" },
  ];
  assert.deepEqual(planPageAccess(pages, "https://product.example/app?view=two"), {
    action: "reuse",
    tab: pages[1],
  });
});

test("an existing product tab on another path is reused", () => {
  const pages = [{ id: "open", url: "https://product.example/current-page" }];
  assert.deepEqual(planPageAccess(pages, "https://product.example/document-page"), {
    action: "reuse",
    tab: pages[0],
  });
});

test("an unrelated site is not mistaken for the product or replaced", () => {
  const pages = [{ id: "open", url: "https://other.example/app" }];
  assert.deepEqual(planPageAccess(pages, "https://product.example/app"), {
    action: "needs-product-page",
    tab: pages[0],
  });
});

test("a blank tab can be navigated while an unrelated site stays open", () => {
  const pages = [
    { id: "other", url: "https://other.example/app" },
    { id: "blank", url: "about:blank" },
  ];
  assert.deepEqual(planPageAccess(pages, "https://product.example/app"), {
    action: "navigate",
    tab: pages[1],
  });
});

test("a blank tab is navigated when no product tab is open", () => {
  const pages = [
    { id: "blank", url: "about:blank" },
    { id: "newtab", url: "chrome://newtab/" },
  ];
  assert.deepEqual(planPageAccess(pages, "https://product.example/app"), {
    action: "navigate",
    tab: pages[0],
  });
});

test("a new tab is created only when Chrome has no tab at all", () => {
  assert.deepEqual(planPageAccess([], "https://product.example/app"), {
    action: "open",
    tab: null,
  });
});

test("an internal nonblank tab does not trigger a new tab", () => {
  const pages = [{ id: "settings", url: "chrome://settings/" }];
  assert.deepEqual(planPageAccess(pages, "https://product.example/app"), {
    action: "needs-blank-tab",
    tab: pages[0],
  });
});

test("the blank-tab path sends Page.navigate and does not create a target", async () => {
  const blank = { id: "blank", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" };
  const loaded = { ...blank, url: "https://product.example/app" };
  let lists = 0;
  await withFakeBrowser(
    async () => ({ json: async () => (lists++ === 0 ? [blank] : [loaded]) }),
    async () => {
      FakeWebSocket.evaluations = [
        { readyState: "complete", url: "about:blank" },
        { readyState: "complete", url: loaded.url },
      ];
      const result = await findOrOpenPage(loaded.url);
      assert.equal(result.navigated, true);
      assert.equal(result.created, false);
      assert.equal(result.tab.url, loaded.url);
      assert.deepEqual(FakeWebSocket.methods, ["Page.navigate", "Runtime.evaluate", "Runtime.evaluate"]);
      assert.deepEqual(FakeWebSocket.urls, ["ws://blank", "ws://blank", "ws://blank"]);
    },
  );
});

test("the zero-tab path creates a target and does not send Page.navigate", async () => {
  const created = {
    id: "created",
    type: "page",
    url: "https://product.example/app",
    webSocketDebuggerUrl: "ws://created",
  };
  let lists = 0;
  await withFakeBrowser(
    async (url) => ({
      json: async () =>
        String(url).endsWith("/json/version")
          ? { webSocketDebuggerUrl: "ws://browser" }
          : lists++ < 6
            ? []
            : [created],
    }),
    async () => {
      FakeWebSocket.evaluations = [{ readyState: "complete", url: created.url }];
      const result = await findOrOpenPage(created.url);
      assert.equal(result.created, true);
      assert.equal(result.navigated, false);
      assert.deepEqual(FakeWebSocket.methods, ["Target.createTarget", "Runtime.evaluate"]);
      assert.deepEqual(FakeWebSocket.urls, ["ws://browser", "ws://created"]);
    },
  );
});

test("an empty startup listing waits for Chrome's blank tab instead of creating one", async () => {
  const blank = { id: "blank", type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://blank" };
  const loaded = { ...blank, url: "https://product.example/app" };
  let lists = 0;
  await withFakeBrowser(
    async () => ({ json: async () => (lists++ === 0 ? [] : lists === 2 ? [blank] : [loaded]) }),
    async () => {
      FakeWebSocket.evaluations = [{ readyState: "complete", url: loaded.url }];
      const result = await findOrOpenPage(loaded.url);
      assert.equal(result.navigated, true);
      assert.equal(result.created, false);
      assert.deepEqual(FakeWebSocket.methods, ["Page.navigate", "Runtime.evaluate"]);
    },
  );
});
