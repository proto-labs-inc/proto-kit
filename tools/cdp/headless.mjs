// The headless Chrome the kit renders replicas and diffs in (MAA-163).
// Nothing rendered here ever appears on screen: the visible Proto
// window (tools/cdp/chrome.mjs, port 9333) is only for the product
// page the user is signed into, and only ever read from.
//
// It must draw exactly like the visible window, or every diff carries
// the difference between two renderers instead of the replica's own.
// Two launch settings decide that, so the headless Chrome is launched
// with the live window's display and relaunched when it changes:
//   - the device scale factor, as a real one (--force-device-scale-factor).
//     Emulating it (Emulation.setDeviceMetricsOverride) lays out in CSS
//     pixels and snaps every fractional edge a device pixel away from
//     where a real 2x screen paints it (docs/cdp-traps.md).
//   - the colour profile (--force-color-profile). A Retina window draws
//     in Display P3; headless defaults to sRGB, so every saturated
//     colour lands a few levels off.
//
// Usage: node tools/cdp/headless.mjs [start|stop] [port]
//   start (the default) finds or starts it at the Proto window's display
//   and prints the port; stop ends it. Its profile is ~/.proto/chrome-headless.
//
// From code: `headlessPage(url, { width, height, display })` opens a
// fresh tab at that viewport on a Chrome launched for that display,
// waits for the load event and for the document's fonts, and returns
// the connected page (call `close()`). `displayOf(page)` reads a live
// page's display.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, evaluate } from "./cdp.mjs";

export const HEADLESS_PORT = 9444;
const PROFILE = join(process.env.HOME ?? "", ".proto", "chrome-headless");
const LAUNCHED = join(PROFILE, "display.json");

/** @typedef {{ dpr: number, colorProfile: "srgb" | "display-p3-d65" }} Display */

/** The display a live page is drawn on: its device scale factor and colour gamut. */
export async function displayOf(page) {
  const [dpr, p3] = await evaluate(page, "[devicePixelRatio, matchMedia('(color-gamut: p3)').matches]");
  return { dpr, colorProfile: p3 ? "display-p3-d65" : "srgb" };
}

async function version(port) {
  try {
    const res = await fetch(`http://localhost:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function launchedDisplay() {
  if (!existsSync(LAUNCHED)) return null;
  try {
    return JSON.parse(readFileSync(LAUNCHED, "utf8"));
  } catch {
    return null;
  }
}

const sameDisplay = (a, b) => a !== null && a.dpr === b.dpr && a.colorProfile === b.colorProfile;

/**
 * Find or start the headless Chrome for a display; resolves once its
 * debug port answers. A Chrome already up for another display is
 * stopped and launched again. Launched through `open`, like the
 * visible window, so it belongs to launchd and no shell waits on it.
 */
export async function ensureHeadless(display, port = HEADLESS_PORT) {
  if (await version(port)) {
    if (sameDisplay(launchedDisplay(), display)) return port;
    await stopHeadless(port);
    for (let i = 0; i < 40 && (await version(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }
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
    `--force-device-scale-factor=${display.dpr}`,
    `--force-color-profile=${display.colorProfile}`,
    "about:blank",
  ]);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await version(port)) {
      writeFileSync(LAUNCHED, JSON.stringify(display) + "\n");
      return port;
    }
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
 * with: the same CSS viewport on a Chrome launched for the same display.
 * The viewport is set exactly with a metrics override carrying the real
 * scale factor (it changes nothing on a Chrome launched at that factor,
 * and the window's own size never decides the viewport). Waits for the
 * load event and for document.fonts, the two things a rect probe must
 * not race.
 */
export async function headlessPage(url, { width, height, display }, port = HEADLESS_PORT) {
  await ensureHeadless(display, port);
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
    deviceScaleFactor: display.dpr,
    mobile: false,
  });
  // Bounded: a navigation whose load event never comes (several lanes
  // opening tabs at once) fails plainly instead of holding a lane forever.
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  const late = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`the headless page ${what} within ${ms / 1000} s`)), ms).unref());
  try {
    await Promise.race([loaded, late(20_000, "did not load")]);
    await Promise.race([evaluate(page, "document.fonts.ready.then(() => document.fonts.status)"), late(8_000, "did not finish loading its fonts")]);
  } catch (error) {
    page.close();
    const b = await connect(info.webSocketDebuggerUrl);
    await b.send("Target.closeTarget", { targetId }).catch(() => {});
    b.close();
    throw error;
  }
  const closeTab = async () => {
    page.close();
    const b = await connect(info.webSocketDebuggerUrl);
    await b.send("Target.closeTarget", { targetId });
    b.close();
  };
  return { page, targetId, close: closeTab };
}

// The Proto window's display, for `start` from the command line: the
// first tab there says what the window is drawn on. Without a window,
// the common Retina display.
async function protoWindowDisplay() {
  try {
    const tabs = await (await fetch("http://localhost:9333/json/list", { signal: AbortSignal.timeout(500) })).json();
    const tab = tabs.find((t) => t.type === "page");
    const page = await connect(tab.webSocketDebuggerUrl);
    const display = await displayOf(page);
    page.close();
    return display;
  } catch {
    return { dpr: 2, colorProfile: "display-p3-d65" };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command = "start", portArg] = process.argv.slice(2);
  const port = Number(portArg || HEADLESS_PORT);
  if (command === "start") {
    const display = await protoWindowDisplay();
    await ensureHeadless(display, port);
    console.log(`headless chrome on ${port} at ${display.dpr}x ${display.colorProfile}, profile ${PROFILE}`);
  } else if (command === "stop") {
    const stopped = await stopHeadless(port);
    console.log(stopped ? `stopped headless chrome on ${port}` : `nothing listening on ${port}`);
  } else {
    console.error("usage: node tools/cdp/headless.mjs [start|stop] [port]");
    process.exit(1);
  }
}
