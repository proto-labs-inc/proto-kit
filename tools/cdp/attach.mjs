// Attach to the visible Proto window (tools/cdp/chrome.mjs, port 9333):
// the product page the user is signed into. Read from it, never
// navigate it, never steal focus. Replicas and diffs go to the
// headless Chrome (tools/cdp/headless.mjs) instead.
import { connect } from "./cdp.mjs";

const base = (port) => `http://localhost:${port}`;

export async function listPages(port = 9333) {
  const res = await fetch(base(port) + "/json/list");
  const targets = await res.json();
  return targets.filter((t) => t.type === "page");
}

// Find the tab whose URL contains `match`. Chrome takes a moment after
// launch to list tabs: an empty list right after startup means retry.
export async function findPage(match, port = 9333) {
  const pages = await listPages(port);
  return pages.find((t) => t.url.includes(match));
}

export async function browser(port = 9333) {
  const res = await fetch(base(port) + "/json/version");
  const info = await res.json();
  return connect(info.webSocketDebuggerUrl);
}

// Open a tab WITHOUT raising the window. (PUT /json/new steals focus: never use it.)
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

// Navigate a tab the kit opened (never the user's). This waits for the
// load event: Page.navigate returns before the document is ready, and
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
