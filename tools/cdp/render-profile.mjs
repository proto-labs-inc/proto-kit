// One way to draw a screen for a pixel comparison, used by both sides of
// it: the live source page's reference capture (tools/cdp/reference.mjs)
// and the copy's verification capture (tools/verify-screen.mjs).
//
// The two used to differ. References came from whatever window the source
// session had (headless Chrome at 1x, or a visible window at the screen's
// 2x), with Chrome's classic 15px scrollbars and the page's own
// ::-webkit-scrollbar styles drawn and taking layout width; the verifier's
// renderer was launched with --hide-scrollbars at the source display's
// scale. Agents spent minutes sampling scrollbar pixels and writing CSS to
// fake them, and real builds failed on 2x copies against 1x references and
// on layouts shifted by a scrollbar's width.
//
// Now both sides, per tab and over CDP, regardless of how their Chrome was
// launched:
//   - the CSS viewport is exactly width x height (Emulation.setDeviceMetricsOverride)
//   - one device pixel per CSS pixel (deviceScaleFactor 1)
//   - no scrollbars at all, custom ones included, so they take no layout
//     width either. Emulation.setScrollbarsHidden hides only Chrome's own;
//     a page's ::-webkit-scrollbar styles still drew and took 15px, so a
//     stylesheet setting scrollbar-width: none on every element (which
//     also turns off ::-webkit-scrollbar) is added to the document, and
//     to every document the tab loads after.
//   - a focused page, so visibility-gated rAF and animations keep running
//   - the capture waits for web fonts, a quiet frame, finished finite
//     animations and decoded visible images (settleForCapture)
//   - colour: both Chromes draw in sRGB (chrome.mjs forces it on the source
//     browser; a screen verification renderer has no source display and
//     launches in sRGB)
export const SCREEN_RENDER = Object.freeze({ dpr: 1, colorProfile: "srgb", scrollbars: "hidden" });

/** Apply the screen render to a tab at a CSS viewport. `dpr` is only for
 *  re-verifying old references captured at another scale. */
const STYLE_ID = "__proto_screen_render";
const HIDE_SCROLLBARS_CSS = "*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}";
/** Page-side, in any document, as early as it has a root element. */
export const HIDE_SCROLLBARS_SCRIPT = `(() => {
  const add = () => {
    if (document.getElementById(${JSON.stringify(STYLE_ID)})) return true;
    const root = document.documentElement;
    if (!root) return false;
    const style = document.createElement("style");
    style.id = ${JSON.stringify(STYLE_ID)};
    style.textContent = ${JSON.stringify(HIDE_SCROLLBARS_CSS)};
    root.appendChild(style);
    return true;
  };
  if (!add()) new MutationObserver((_, observer) => { if (add()) observer.disconnect(); }).observe(document, { childList: true, subtree: true });
  return true;
})()`;
const REMOVE_SCROLLBAR_STYLE = `(document.getElementById(${JSON.stringify(STYLE_ID)})?.remove(), true)`;

export async function applyScreenRender(page, { width, height, dpr = SCREEN_RENDER.dpr }) {
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: dpr,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
  await page.send("Emulation.setScrollbarsHidden", { hidden: true });
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  if (!page.screenRenderScript) {
    page.screenRenderScript = (await page.send("Page.addScriptToEvaluateOnNewDocument", { source: HIDE_SCROLLBARS_SCRIPT })).identifier;
    await page.send("Runtime.evaluate", { expression: HIDE_SCROLLBARS_SCRIPT });
  }
}

/** Undo applyScreenRender on a tab that outlives the capture (the source window). */
export async function clearScreenRender(page) {
  if (page.screenRenderScript) {
    await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: page.screenRenderScript }).catch(() => {});
    delete page.screenRenderScript;
  }
  await page.send("Runtime.evaluate", { expression: REMOVE_SCROLLBAR_STYLE }).catch(() => {});
  await page.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
  await page.send("Emulation.setScrollbarsHidden", { hidden: false }).catch(() => {});
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: false }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Settling: a capture waits until the page is done loading and moving.
//
// A signed-in SPA (the Supabase settings page) used to be shot while it
// still drew skeleton rows, a spinner avatar and a placeholder org name,
// and the frozen copy kept framer-motion's mid-animation inline
// `opacity: 0; transform` on header items. A page counts as settled when,
// at once:
//   - the network is idle: no request in flight for NETWORK_QUIET_MS
//     (WebSockets, EventSource and requests open longer than
//     LONG_REQUEST_MS are ignored: they never finish), when the tab's
//     requests are tracked (trackNetwork, before navigating);
//   - no visible loading indicator (BUSY_SELECTOR); one still showing
//     MARKER_GRACE_MS after the network went quiet is reported, not waited on;
//   - web fonts are loaded and visible images complete and decoded;
//   - no finite animation is running: the Animation domain fast-forwards the
//     page's timeline and each finite CSS/Web animation is finished (seeked to
//     its end). Infinite ones (spinners, pulses) are ignored, and so are the
//     elements they move. prefers-reduced-motion is not emulated here: the
//     render profile only emulates it when the plan's capture profile asks;
//   - the layout is stable: no element's box or inline style changes across
//     three consecutive animation frames (script-driven motion like
//     framer-motion's rAF tweens, which no animation list shows).
// Each settle is bounded (timeoutMs); a page that does not settle is shot
// anyway and the result says why.
export const SETTLE_TIMEOUT_MS = 15_000;
export const NETWORK_QUIET_MS = 500;
export const LONG_REQUEST_MS = 10_000;
export const MARKER_GRACE_MS = 2_000;
const FAST_PLAYBACK = 100;

/** Loading indicators a settled page no longer shows. */
export const BUSY_SELECTOR = [
  '[aria-busy="true"]', '[role="progressbar"]:not([aria-valuenow])', "progress:not([value])",
  '[class*="skeleton" i]', '[class*="shimmer" i]', '[class*="spinner" i]', '[class*="loading-indicator" i]',
  ".animate-pulse", ".animate-spin", '[class*="lucide-loader"]', '[data-loading="true"]', '[data-state="loading"]',
].join(",");

/** Track the tab's in-flight requests from now on (call before navigating). */
export async function trackNetwork(page) {
  if (page.network) return page.network;
  const state = { inflight: new Map(), lastActivity: Date.now() };
  const finished = ({ requestId }) => { if (state.inflight.delete(requestId)) state.lastActivity = Date.now(); };
  page.on("Network.requestWillBeSent", ({ requestId, type, request }) => {
    if (["WebSocket", "EventSource"].includes(type) || /^(data|blob):/.test(request?.url ?? "")) return;
    state.inflight.set(requestId, { at: Date.now(), url: request?.url ?? "" });
    state.lastActivity = Date.now();
  });
  page.on("Network.loadingFinished", finished);
  page.on("Network.loadingFailed", finished);
  await page.send("Network.enable");
  page.network = state;
  return state;
}

/** Is the tracked network idle now? Untracked tabs count as idle. */
export function networkIdle(state, now = Date.now()) {
  if (!state) return { idle: true, pending: [], since: 0 };
  const pending = [...state.inflight.values()].filter(request => now - request.at < LONG_REQUEST_MS);
  const quietFor = now - Math.max(state.lastActivity, ...pending.map(request => request.at));
  return { idle: !pending.length && quietFor >= NETWORK_QUIET_MS, pending: pending.map(request => request.url), since: pending.length ? null : now - quietFor };
}

/** Page-side, in the (possibly scoped) document: finishes finite animations,
 *  then reports what still keeps the page from being settled. Uses only
 *  window./document. names so it can run inside the verifier's iframe. */
export const SETTLE_PROBE = `(async () => {
  const BUSY = ${JSON.stringify(BUSY_SELECTOR)};
  const frame = () => new Promise(resolve => {
    let done = false;
    const timer = setTimeout(() => { done = true; resolve(); }, 120);
    window.requestAnimationFrame(() => { if (!done) { clearTimeout(timer); resolve(); } });
  });
  const name = (element) => {
    const id = element.id ? '#' + element.id : '';
    const cls = typeof element.className === 'string' && element.className.trim() ? '.' + element.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30);
    return element.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
  };
  const inView = (element) => {
    if (!element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  };
  await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 2000))]);
  const fonts = document.fonts.status === 'loaded';
  let finished = 0;
  const infinite = new Set();
  for (const animation of document.getAnimations()) {
    const timing = animation.effect?.getComputedTiming?.();
    if (!timing) continue;
    if (!Number.isFinite(timing.endTime)) {
      if (animation.effect.target) infinite.add(animation.effect.target);
      continue;
    }
    if (animation.playState === 'running' || (animation.pending && animation.playState !== 'paused')) {
      try { animation.finish(); finished++; } catch {}
    }
  }
  const images = [];
  const decoding = [];
  for (const image of document.images) {
    if (!inView(image)) continue;
    if (!image.complete) images.push(image.currentSrc || image.src);
    else if (image.naturalWidth) decoding.push(image.decode().catch(() => {}));
  }
  await Promise.race([Promise.all(decoding), new Promise(resolve => setTimeout(resolve, 2000))]);
  const busy = [...document.querySelectorAll(BUSY)].filter(inView).slice(0, 3).map(name);
  const skip = new Set();
  for (const target of infinite) { skip.add(target); for (const inner of target.querySelectorAll('*')) skip.add(inner); }
  const elements = [...(document.body?.querySelectorAll('*') ?? [])].filter(element => !skip.has(element)).slice(0, 5000);
  const print = () => elements.map(element => {
    const rect = element.getBoundingClientRect();
    return Math.round(rect.x * 2) + ',' + Math.round(rect.y * 2) + ',' + Math.round(rect.width * 2) + ',' + Math.round(rect.height * 2) + '|' + (element.getAttribute('style') || '');
  });
  await frame();
  let previous = print();
  let moving = null;
  for (let i = 0; i < 2 && !moving; i++) {
    await frame();
    const next = print();
    const index = next.findIndex((value, at) => value !== previous[at]);
    if (index >= 0) moving = name(elements[index]);
    previous = next;
  }
  return { fonts, images: images.slice(0, 3), busy, finished, infinite: infinite.size, moving };
})()`;

/** Wait until the page is settled (see above), at most `timeoutMs`.
 *  `scope` wraps a page-side expression to run in another document (the
 *  verifier's iframe); identity for the top document. Returns
 *  { settled, ms, reasons, lingering }: `reasons` says what was still
 *  happening when the time ran out; `lingering` names loading indicators
 *  that stayed after the network went quiet (not waited on). */
export async function settleForCapture(page, evaluate, scope = (expression) => expression, { timeoutMs = SETTLE_TIMEOUT_MS } = {}) {
  const started = Date.now();
  const end = started + timeoutMs;
  let fast = false;
  try {
    await page.send("Animation.enable");
    await page.send("Animation.setPlaybackRate", { playbackRate: FAST_PLAYBACK });
    fast = true;
  } catch {}
  let reasons = [];
  let lingering = [];
  try {
    for (;;) {
      let probe;
      try { probe = await evaluate(page, scope(SETTLE_PROBE), { timeoutMs: Math.max(5_000, end - Date.now() + 5_000) }); }
      catch (error) { probe = { error: error.message }; }
      const now = Date.now();
      const network = networkIdle(page.network, now);
      reasons = [];
      lingering = [];
      if (probe.error) reasons.push(`the page could not be read (${probe.error.split("\n")[0]})`);
      if (!network.idle) reasons.push(network.pending.length
        ? `${network.pending.length} request(s) still loading (${network.pending.slice(0, 2).join(", ")})`
        : "requests finished less than half a second ago");
      if (probe.fonts === false) reasons.push("web fonts still loading");
      if (probe.images?.length) reasons.push(`images still loading (${probe.images.join(", ")})`);
      if (probe.finished) reasons.push(`${probe.finished} animation(s) were still running`);
      if (probe.moving) reasons.push(`layout still moving (${probe.moving})`);
      if (probe.busy?.length) {
        const quietSince = network.since ?? now;
        if (network.idle && now - Math.max(quietSince, started) >= MARKER_GRACE_MS) lingering = probe.busy;
        else reasons.push(`loading indicator visible (${probe.busy.join(", ")})`);
      }
      if (!reasons.length) return { settled: true, ms: now - started, reasons: [], lingering };
      if (now >= end) return { settled: false, ms: now - started, reasons, lingering };
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  } finally {
    if (fast) {
      await page.send("Animation.setPlaybackRate", { playbackRate: 1 }).catch(() => {});
      await page.send("Animation.disable").catch(() => {});
    }
  }
}

/** One line for a settle that timed out or left an indicator showing; null when clean. */
export function settleProblem(result, where) {
  if (!result) return null;
  if (!result.settled) return `${where} did not settle within ${Math.round(result.ms / 1000)} s: ${result.reasons.join("; ")}`;
  if (result.lingering?.length) return `${where} still shows a loading indicator after the network went quiet: ${result.lingering.join(", ")}`;
  return null;
}

/** Width and height of a PNG file's image, from its header. */
export function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("latin1", 12, 16) !== "IHDR") throw new Error("Not a PNG image");
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
}

/** The scale a reference was captured at, if it is a whole multiple of the
 *  viewport (1 for every reference reference.mjs takes); null otherwise. */
export function referenceScale([width, height], viewport) {
  for (const scale of [1, 2, 3])
    if (width === viewport.width * scale && height === viewport.height * scale) return scale;
  return null;
}
