// Clip screenshots behind a stability gate. The live page is a moving
// target (resizes, animations, sibling agents): a capture only counts if
// the page state provably held still across it. Works the same on the
// visible window's tabs and the headless Chrome's.
//
// The whole viewport is captured and the clip is cut in node. Never
// pass `clip` to Page.captureScreenshot on a tab that is not the
// active one: Chrome resizes that tab's view to the clip while it
// waits for a frame, the frame sometimes never comes on a background
// tab, and the resize outlives the capture (docs/cdp-traps.md).
import { writeFileSync } from "node:fs";
import { evaluate } from "./cdp.mjs";
import { cropPng, decodePng, encodePng, scalePng } from "./png.mjs";

// probeExpr: page-side expression returning a JSON string of everything
// that must hold still: target rects, innerWidth/innerHeight, dynamic
// texts, document.fonts.status. Build it per capture.
// clip: { x, y, width, height } in CSS px, optionally `scale`, the
// device pixels per CSS px the file should have (default: the tab's
// own devicePixelRatio).
export async function stableShot(page, probeExpr, outPath, clip) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const before = await evaluate(page, probeExpr);
    await new Promise((r) => setTimeout(r, 350));
    const again = await evaluate(page, probeExpr);
    if (again !== before) continue;
    const dpr = await evaluate(page, "devicePixelRatio");
    const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const after = await evaluate(page, probeExpr);
    if (after !== before) continue;
    let image = Buffer.from(shot.data, "base64");
    if (clip) {
      let decoded = cropPng(decodePng(image), {
        x: Math.round(clip.x * dpr),
        y: Math.round(clip.y * dpr),
        width: Math.round(clip.width * dpr),
        height: Math.round(clip.height * dpr),
      });
      if (clip.scale !== undefined && clip.scale !== dpr) decoded = scalePng(decoded, clip.scale / dpr);
      image = encodePng(decoded);
    }
    writeFileSync(outPath, image);
    return JSON.parse(before);
  }
  throw new Error("page never held still across a capture");
}

// Standard probe pieces to concatenate into probeExpr.
export const FONTS_LOADED = `document.fonts.status`;
export const VIEWPORT = `[innerWidth, innerHeight]`;
export const rectOf = (selector) =>
  `(r => [r.x, r.y, r.width, r.height])(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`;

/**
 * stableShot for a tab that is the active one in its browser (the
 * headless Chrome's): the clip is taken by Chrome itself, so only the
 * clip's pixels are encoded, sent and written. Never on a background
 * tab of the visible window (see stableShot).
 */
export async function stableClip(page, probeExpr, outPath, clip) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const before = await evaluate(page, probeExpr);
    await new Promise((r) => setTimeout(r, 100));
    const again = await evaluate(page, probeExpr);
    if (again !== before) continue;
    const shot = await page.send("Page.captureScreenshot", { format: "png", fromSurface: true, clip });
    const after = await evaluate(page, probeExpr);
    if (after !== before) continue;
    writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    return JSON.parse(before);
  }
  throw new Error("page never held still across a capture");
}
