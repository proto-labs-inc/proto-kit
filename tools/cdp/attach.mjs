// Attach to the person's running Chrome (started with --remote-debugging-port).
// We never launch Chrome for them and never steal focus.
import { connect } from "./cdp.mjs";

const base = (port) => `http://localhost:${port}`;

export async function listPages(port = 9333) {
  const res = await fetch(base(port) + "/json/list");
  const targets = await res.json();
  return targets.filter((t) => t.type === "page");
}

// Base URL of our own static server (tools/serve.mjs). Only pages from
// this origin are "our own". Do not widen this to all of localhost:
// target apps often run on localhost ports during development.
export const TOOL_BASE = "http://localhost:8123";

// Find the target tab whose URL contains `match`. Pages from our own
// server are excluded — otherwise a match like "wikipedia" can hit our
// own wireframe/diff pages and the tool reads its own output.
// Chrome takes a moment after launch to list tabs — an empty list right
// after startup means retry.
export async function findPage(match, port = 9333, toolBase = TOOL_BASE) {
  const pages = await listPages(port);
  return pages.find((t) => t.url.includes(match) && !t.url.startsWith(toolBase));
}

// Find one of our own served pages (diff view, wireframe view).
export async function findToolPage(match, port = 9333, toolBase = TOOL_BASE) {
  const pages = await listPages(port);
  return pages.find((t) => t.url.startsWith(toolBase) && t.url.includes(match));
}

export async function browser(port = 9333) {
  const res = await fetch(base(port) + "/json/version");
  const info = await res.json();
  return connect(info.webSocketDebuggerUrl);
}

// Open a tab WITHOUT raising the window. (PUT /json/new steals focus — never use it.)
// Waits for the document to finish loading before returning: the target
// appears in /json/list while its document is still null, and evaluating
// against it throws.
export async function openBackground(url, port = 9333) {
  const b = await browser(port);
  const { targetId } = await b.send("Target.createTarget", { url, background: true });
  b.close();
  for (let i = 0; i < 20; i++) {
    const pages = await listPages(port);
    const tab = pages.find((t) => t.id === targetId);
    if (tab) {
      const { connect } = await import("./cdp.mjs");
      const page = await connect(tab.webSocketDebuggerUrl);
      for (let j = 0; j < 40; j++) {
        try {
          const r = await page.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true });
          if (r.result.value === "complete") break;
        } catch {}
        await new Promise((r) => setTimeout(r, 250));
      }
      page.close();
      return tab;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("created target never appeared in /json/list");
}

// Reuse a worker tab. Navigation never raises focus. This waits for the
// load event — Page.navigate returns before the document is ready, and
// evaluating against a mid-navigation document races or hangs.
export async function navigate(page, url) {
  await page.send("Page.enable");
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
}

// Close a tab opened with openBackground. Pass the tab object or its id.
export async function closePage(tabOrId, port = 9333) {
  const b = await browser(port);
  await b.send("Target.closeTarget", { targetId: tabOrId.id || tabOrId });
  b.close();
}
