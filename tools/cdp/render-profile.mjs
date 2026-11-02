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

/** Page-side: resolves once fonts are loaded, finite animations have
 *  ended, visible images are decoded and two frames have been drawn. */
export const SETTLE_EXPRESSION = `(async () => {
  const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const end = Date.now() + 8000;
  await document.fonts.ready;
  while (Date.now() < end) {
    const moving = document.getAnimations().some(a => Number.isFinite(a.effect?.getComputedTiming().endTime) && a.playState === 'running');
    const loading = Array.from(document.images).some(image => {
      const rect = image.getBoundingClientRect();
      const visible = image.checkVisibility() && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      return visible && !image.complete;
    });
    if (!moving && !loading) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await document.fonts.ready;
  await frame();
  return document.fonts.status;
})()`;

/** `scope` wraps a page-side expression to run in another document (the
 *  verifier's iframe); identity for the top document. */
export async function settleForCapture(page, evaluate, scope = (expression) => expression) {
  return evaluate(page, scope(SETTLE_EXPRESSION));
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
