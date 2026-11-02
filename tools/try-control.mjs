#!/usr/bin/env node
/**
 * Clicks one control on the real site and says what it does, so an agent
 * adding interactivity to one part of a prototype copies the site's own
 * behaviour instead of guessing. Runs in this run's own source window
 * (tools/cdp/product-page.mjs), never another tab. Every request that could
 * change data (anything but GET, HEAD and OPTIONS) is blocked while it runs,
 * so trying "Delete" or "Save" on the real site changes nothing there.
 *
 * Usage: node tools/try-control.mjs '<url>' --codebase <id> --run <runId>
 *          --click "<label>" [--in "<css selector>"] [--out <dir>]
 *
 * --click is the control's accessible name or visible text, matched exactly
 * after trimming; --in limits the search to one region. Prints one JSON
 * line: { clicked, url: { before, after }, opened: [{ role, label, html }],
 * changed: [{ selector, attribute, before, after }], blocked: [{ method, url }],
 * picture } and puts the page back (Escape, then the first URL) afterwards.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { connect, evaluate } from "./cdp/cdp.mjs";
import { acquireSourceSession } from "./cdp/source-session.mjs";
import { useBuildSession } from "./cdp/session-context.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const SETTLE_MS = 900;

/** Whether a request could change data on the real site. */
export function isWrite(method) {
  return !SAFE_METHODS.has(String(method).toUpperCase());
}

/** In the page: find the control, start recording what changes. */
export function prepareExpression(label, scope) {
  return `(() => {
    const root = ${scope ? `document.querySelector(${JSON.stringify(scope)})` : "document.body"};
    if (!root) return { error: "No element matches --in" };
    const name = el => (el.getAttribute("aria-label") || el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    const candidates = [...root.querySelectorAll("button,a,summary,input,select,[role],[aria-haspopup],[aria-expanded],[tabindex]")]
      .filter(el => name(el) === ${JSON.stringify(label)} && el.checkVisibility());
    const control = candidates[0];
    if (!control) return { error: "No visible control is called " + ${JSON.stringify(JSON.stringify(label))} };
    control.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = control.getBoundingClientRect();
    const record = { added: [], attributes: [] };
    const observer = new MutationObserver(list => {
      for (const m of list) {
        if (m.type === "childList") for (const node of m.addedNodes) if (node.nodeType === 1) record.added.push(node);
        if (m.type === "attributes") record.attributes.push({ target: m.target, attribute: m.attributeName, before: m.oldValue });
      }
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeOldValue: true });
    window.__protoTryControl = { observer, record, control };
    return { candidates: candidates.length, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, label: name(control) };
  })()`;
}

/** In the page: what the click made appear or change, then stop recording. */
export const REPORT_EXPRESSION = `(() => {
  const state = window.__protoTryControl;
  if (!state) return null;
  state.observer.disconnect();
  delete window.__protoTryControl;
  const name = el => (el.getAttribute("aria-label") || el.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120);
  const path = el => {
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 4; node = node.parentElement) {
      parts.unshift(node.id ? "#" + CSS.escape(node.id) : node.tagName.toLowerCase());
      if (node.id) break;
    }
    return parts.join(" > ");
  };
  const opened = state.record.added
    .filter(el => el.isConnected && el.checkVisibility() && !state.record.added.some(other => other !== el && other.contains(el)))
    .slice(0, 6)
    .map(el => ({ role: el.getAttribute("role") || el.querySelector("[role]")?.getAttribute("role") || el.tagName.toLowerCase(), label: name(el), html: el.outerHTML.slice(0, 6000) }));
  const seen = new Set();
  const changed = state.record.attributes
    .filter(({ target, attribute }) => target.isConnected && /^(aria-|data-state|open|hidden|class)/.test(attribute))
    .filter(({ target, attribute }) => { const key = path(target) + attribute; if (seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 20)
    .map(({ target, attribute, before }) => ({ selector: path(target), attribute, before, after: target.getAttribute(attribute) }));
  return { opened, changed };
})()`;

/** Click one control in an open CDP page with writes blocked; report what it did. */
export async function tryControl(page, { label, scope, picture }) {
  const blocked = [];
  const stop = page.on("Fetch.requestPaused", ({ requestId, request }) => {
    if (isWrite(request.method)) {
      blocked.push({ method: request.method, url: request.url });
      void page.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
    } else void page.send("Fetch.continueRequest", { requestId }).catch(() => {});
  });
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  try {
    const before = await evaluate(page, "location.href");
    const found = await evaluate(page, prepareExpression(label, scope));
    if (found.error) throw new Error(found.error);
    // A real pointer press: menus built on Radix and similar open on pointerdown, not click.
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await page.send("Input.dispatchMouseEvent", { type, x: found.x, y: found.y, button: "left", clickCount: type === "mouseMoved" ? 0 : 1 });
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    const after = await evaluate(page, "location.href");
    const report = await evaluate(page, REPORT_EXPRESSION);
    if (picture) {
      const { data } = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(picture, Buffer.from(data, "base64"));
    }
    // Put the page back for the next try.
    for (const type of ["keyDown", "keyUp"])
      await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    if (after !== before) await page.send("Page.navigate", { url: before });
    return { clicked: found.label, matches: found.candidates, url: { before, after }, ...report, blocked, picture };
  } finally {
    stop();
    await page.send("Fetch.disable").catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  const [url] = args;
  const label = flag("--click");
  if (!url || !label || !flag("--codebase") || !flag("--run")) {
    console.error("usage: node tools/try-control.mjs '<url>' --codebase <id> --run <runId> --click \"<label>\" [--in \"<css selector>\"] [--out <dir>]");
    process.exit(1);
  }
  const sessionPath = useBuildSession(flag("--codebase"), flag("--run"));
  const { tab } = await acquireSourceSession(url);
  const out = flag("--out") ?? join(dirname(sessionPath), "try-control");
  mkdirSync(out, { recursive: true });
  const picture = join(out, `${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "control"}.png`);
  const page = await connect(tab.webSocketDebuggerUrl);
  try {
    await page.send("Page.enable");
    console.log(JSON.stringify(await tryControl(page, { label, scope: flag("--in"), picture })));
  } finally {
    page.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
