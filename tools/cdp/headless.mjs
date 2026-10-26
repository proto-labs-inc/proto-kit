import { dirname } from "node:path";
import { browserSessionPath, browserArguments, readSession, writeSession } from "./session-context.mjs";
import { withProcessLock } from "../process-lock.mjs";
import { reservePort, releasePort } from "../ports.mjs";
// Each owned source session gets a renderer process/profile and reserved port.
// Its captured display determines rasterization. Parallel captures in that run
// use separate windows; cleanup never stops another run's renderer.
// Standalone library preview rendering retains the default renderer on 9444.
// CLI: headless.mjs [start|stop] [port] [--browser-session <path>]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, evaluate } from "./cdp.mjs";
import { protoHome } from "../proto-home.mjs";

export const HEADLESS_PORT = 9444;
const PROFILE = join(protoHome(), "chrome-headless");
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
 * The display the headless Chrome on `port` is running at, asked of
 * the Chrome itself (a blank tab's devicePixelRatio and colour gamut),
 * not of a file: the record under one HOME says nothing to a process
 * under another, and two homes taking turns stopped and relaunched
 * the one shared Chrome under each other's captures.
 */
async function runningDisplay(port) {
  const info = await version(port);
  if (!info) return null;
  let browser;
  try {
    browser = await connect(info.webSocketDebuggerUrl);
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    try {
      const tabs = await (await fetch(`http://localhost:${port}/json/list`)).json();
      const tab = tabs.find((t) => t.id === targetId);
      const page = await connect(tab.webSocketDebuggerUrl);
      try {
        return await displayOf(page);
      } finally {
        page.close();
      }
    } finally {
      await browser.send("Target.closeTarget", { targetId }).catch(() => {});
    }
  } catch {
    return null;
  } finally {
    browser?.close();
  }
}

/** Pages open in the headless Chrome on `port`: someone is using it. */
async function openPages(port) {
  try {
    const tabs = await (await fetch(`http://localhost:${port}/json/list`, { signal: AbortSignal.timeout(500) })).json();
    return tabs.filter((t) => t.type === "page" && t.url !== "about:blank").length;
  } catch {
    return 0;
  }
}

/** Start or reuse this session's renderer, serialized against shutdown. */
export async function ensureHeadless(callerDisplay, port = HEADLESS_PORT) {
  const session = browserSessionPath();
  const profile = session ? join(dirname(session), "chrome-headless") : PROFILE;
  const rendererPath = join(profile, "renderer.json");
  return withProcessLock(join(profile, "startup.lock"), async () => {
    if (session) port = await reservePort({ owner: rendererPath, from: 19444, to: 20444 });
    let display = callerDisplay;
    if (!display || !Number.isFinite(display.dpr) || !display.colorProfile) {
      if (session) {
        const source = readSession(session);
        display = source?.display ?? { dpr: 2, colorProfile: "srgb" };
      } else display = await theDisplay();
    }
    return startHeadless(display, port, profile, rendererPath);
  });
}

async function startHeadless(display, port, profile, rendererPath) {
  const current = await version(port);
  if (current) {
    if (browserSessionPath() && readSession(rendererPath)?.browserId !== current.webSocketDebuggerUrl) throw new Error(`Renderer port ${port} belongs to another browser; it was left untouched`);
    const running = await runningDisplay(port);
    if (sameDisplay(running, display)) return { port, display: running };
    if ((await openPages(port)) > 0) throw new Error("Renderer display changed while captures are active; retry after they finish");
    await stopHeadless(port);
    // The port must be free before the launch, or the new Chrome dies on it and nothing comes up.
    for (let i = 0; i < 150 && (await version(port)); i++) await new Promise((r) => setTimeout(r, 100));
  }
  mkdirSync(profile, { recursive: true });
  execFileSync("open", [
    "-g",
    "-n",
    "-a", "Google Chrome",
    "--args",
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
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
      writeFileSync(join(profile, "display.json"), JSON.stringify(display) + "\n");
      writeSession(rendererPath, { port, browserId: (await version(port)).webSocketDebuggerUrl });
      return { port, display };
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
export async function headlessPage(url, { width, height, display: _asked }, port = HEADLESS_PORT) {
  const renderer = await ensureHeadless(_asked, port);
  port = renderer.port;
  const { display } = renderer;
  const info = await version(port);
  const browser = await connect(info.webSocketDebuggerUrl);
  // Its own window at the viewport's size: tabs sharing one window while
  // several lanes capture at once came back as tiles of the page (header
  // and sidebar repeated), since only the front tab of a window is drawn
  // at its emulated size.
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank", newWindow: true, width, height });
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
    return null;
  }
}

/** The display every headless render uses: the Proto window's, else the
 *  last one recorded from it, else the common Retina display. Never a
 *  caller's: a caller that passed { dpr: 1 } without its colour profile
 *  once relaunched the Chrome under a running check and wrote that
 *  half display for every later check to read. */
async function theDisplay() {
  return (await protoWindowDisplay()) ?? launchedDisplay() ?? { dpr: 2, colorProfile: "display-p3-d65" };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [command = "start", portArg] = browserArguments();
  const port = Number(portArg || HEADLESS_PORT);
  if (command === "start") {
    const renderer = await ensureHeadless(null, port);
    console.log(`headless chrome on ${renderer.port} at ${renderer.display.dpr}x ${renderer.display.colorProfile}`);
  } else if (command === "stop") {
    let stopped;
    if (browserSessionPath()) { await stopSessionRenderer(browserSessionPath()); stopped = true; }
    else stopped = await stopHeadless(port);
    console.log(stopped ? `stopped headless chrome on ${port}` : `nothing listening on ${port}`);
  } else {
    console.error("usage: node tools/cdp/headless.mjs [start|stop] [port]");
    process.exit(1);
  }
}

export async function stopSessionRenderer(sessionPath) {
  const profile = join(dirname(sessionPath), "chrome-headless");
  const path = join(profile, "renderer.json");
  return withProcessLock(join(profile, "startup.lock"), async () => {
    const renderer = readSession(path);
    if (!renderer) { await releasePort(path); return; }
    const current = await version(renderer.port);
    if (current && current.webSocketDebuggerUrl !== renderer.browserId) throw new Error("Renderer identity changed; no unrelated browser was stopped");
    if (current) {
      if (await openPages(renderer.port) > 0) throw new Error("Renderer still has active captures; finish them before releasing this session");
      await stopHeadless(renderer.port);
      for (let i = 0; i < 40 && await version(renderer.port); i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (await version(renderer.port)) throw new Error("Renderer did not stop; reservation retained");
    }
    rmSync(path, { force: true });
    await releasePort(path);
  });
}
