// The headless Chrome the kit renders replicas and diffs in (MAA-163).
// Nothing rendered here ever appears on screen: the visible Proto
// window (tools/cdp/chrome.mjs, port 9333) is only for the product
// page the user is signed into, and only ever read from.
//
// Usage: node tools/cdp/headless.mjs [start|stop] [port]
//   start (the default) finds or starts it and prints the port;
//   stop ends it. Its profile is ~/.proto/chrome-headless.
//
// From code: `headlessPage(url, { width, height, dpr })` opens a fresh
// tab at the given viewport, waits for the load event and for the
// document's fonts, and returns the connected page (call `close()`).
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, evaluate } from "./cdp.mjs";

export const HEADLESS_PORT = 9444;
const PROFILE = join(process.env.HOME ?? "", ".proto", "chrome-headless");

async function version(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Find or start the headless Chrome; resolves once its debug port
 * answers. Launched through `open`, like the visible window, so it
 * belongs to launchd and no shell waits on it.
 */
export async function ensureHeadless(port = HEADLESS_PORT) {
  if (await version(port)) return port;
  mkdirSync(PROFILE, { recursive: true });
  execFileSync("open", [
    "-g",
    "-n",
    "-a", "Google Chrome",
    "--args",
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "about:blank",
  ]);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await version(port)) return port;
  }
  throw new Error("headless Chrome did not come up in 15s");
}

export async function stopHeadless(port = HEADLESS_PORT) {
  const info = await version(port);
  if (!info) return false;
  const browser = await connect(info.webSocketDebuggerUrl);
  await browser.send("Browser.close").catch(() => {});
  browser.close();
  return true;
}

/**
 * A fresh tab at `url`, sized like the live tab it will be compared
 * with: the same CSS viewport and device pixel ratio, or the capture
 * comes back at the wrong size. Waits for the load event and for
 * document.fonts, the two things a rect probe must not race.
 */
export async function headlessPage(url, { width, height, dpr }, port = HEADLESS_PORT) {
  await ensureHeadless(port);
  const info = await version(port);
  const browser = await connect(info.webSocketDebuggerUrl);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  browser.close();
  const tabs = await (await fetch(`http://localhost:${port}/json/list`)).json();
  const tab = tabs.find((t) => t.id === targetId);
  const page = await connect(tab.webSocketDebuggerUrl);
  await page.send("Page.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile: false,
  });
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await loaded;
  await evaluate(page, "document.fonts.ready.then(() => document.fonts.status)");
  const closeTab = async () => {
    page.close();
    const b = await connect(info.webSocketDebuggerUrl);
    await b.send("Target.closeTarget", { targetId });
    b.close();
  };
  return { page, targetId, close: closeTab };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command = "start", portArg] = process.argv.slice(2);
  const port = Number(portArg || HEADLESS_PORT);
  if (command === "start") {
    await ensureHeadless(port);
    console.log(`headless chrome on ${port}, profile ${PROFILE}`);
  } else if (command === "stop") {
    const stopped = await stopHeadless(port);
    console.log(stopped ? `stopped headless chrome on ${port}` : `nothing listening on ${port}`);
  } else {
    console.error("usage: node tools/cdp/headless.mjs [start|stop] [port]");
    process.exit(1);
  }
}
