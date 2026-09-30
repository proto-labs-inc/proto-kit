// Attach to the visible Proto window (tools/cdp/chrome.mjs, port 9333).
// Reuse product tabs and navigate only an unused blank tab. Replicas and
// diffs go to the headless Chrome (tools/cdp/headless.mjs) instead.
import { connect } from "./cdp.mjs";

const base = (port) => `http://localhost:${port}`;

export async function listPages(port = 9333) {
  const res = await fetch(base(port) + "/json/list");
  const targets = await res.json();
  return targets.filter((t) => t.type === "page");
}

// Find the tab whose URL contains `match`.
export async function findPage(match, port = 9333) {
  const pages = await listPages(port);
  return pages.find((t) => t.url.includes(match));
}

export async function browser(port = 9333) {
  const res = await fetch(base(port) + "/json/version");
  const info = await res.json();
  return connect(info.webSocketDebuggerUrl);
}

// Reuse the requested page or another page of the same product. With no
// product page, navigate a blank tab. Another site must be handled by the
// user, and a new target is created only when Chrome has no tabs at all.
export function planPageAccess(pages, url) {
  const wanted = new URL(url);
  if (!["http:", "https:"].includes(wanted.protocol)) throw new Error("the product URL must be http or https");
  const readable = pages.filter((tab) => {
    try {
      return ["http:", "https:"].includes(new URL(tab.url).protocol);
    } catch {
      return false;
    }
  });
  const exact = readable.find((tab) => {
    const current = new URL(tab.url);
    return current.origin === wanted.origin && current.pathname === wanted.pathname;
  });
  if (exact) return { action: "reuse", tab: exact };
  const sameOrigin = readable.find((tab) => new URL(tab.url).origin === wanted.origin);
  if (sameOrigin) return { action: "reuse", tab: sameOrigin };
  const blank = pages.find((tab) => tab.url === "about:blank" || tab.url.startsWith("chrome://newtab"));
  if (blank) return { action: "navigate", tab: blank };
  if (readable.length) return { action: "needs-product-page", tab: readable[0] };
  if (pages.length) return { action: "needs-blank-tab", tab: pages[0] };
  return { action: "open", tab: null };
}

async function waitUntilLoaded(tab, port) {
  for (let i = 0; i < 40; i++) {
    const current = (await listPages(port)).find((candidate) => candidate.id === tab.id);
    if (!current) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }
    try {
      const page = await connect(current.webSocketDebuggerUrl);
      let r;
      try {
        r = await page.send("Runtime.evaluate", {
          expression: "({ readyState: document.readyState, url: location.href })",
          returnByValue: true,
        });
      } finally {
        page.close();
      }
      const state = r.result?.value;
      if (state?.readyState === "complete" && /^https?:\/\//.test(state.url)) {
        return { ...current, url: state.url };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("page did not finish loading");
}

// Reuse a readable page, navigate a blank one, or create a target as the last
// resort. A readable existing page is never navigated.
export async function findOrOpenPage(url, port = 9333) {
  let pages = await listPages(port);
  // Chrome can briefly report no pages after its debug endpoint appears.
  for (let i = 0; pages.length === 0 && i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    pages = await listPages(port);
  }
  const plan = planPageAccess(pages, url);
  if (plan.action === "reuse") return { tab: plan.tab, created: false, navigated: false };
  if (plan.action === "needs-product-page") {
    throw new Error(`a different site is open in the Proto window (${plan.tab.url}); show the product page there and retry`);
  }
  if (plan.action === "needs-blank-tab") {
    throw new Error("the Proto window has only internal pages; show the product page there and retry");
  }
  if (plan.action === "navigate") {
    const page = await connect(plan.tab.webSocketDebuggerUrl);
    try {
      const result = await page.send("Page.navigate", { url });
      if (result.errorText) throw new Error(`could not open the product page: ${result.errorText}`);
    } finally {
      page.close();
    }
    const tab = await waitUntilLoaded(plan.tab, port);
    return { tab, created: false, navigated: true };
  }

  const b = await browser(port);
  const { targetId } = await b.send("Target.createTarget", { url, background: true });
  b.close();
  for (let i = 0; i < 20; i++) {
    const tab = (await listPages(port)).find((candidate) => candidate.id === targetId);
    if (tab) {
      return { tab: await waitUntilLoaded(tab, port), created: true, navigated: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("created target never appeared in /json/list");
}
