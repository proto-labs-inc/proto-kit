// Clip screenshots behind a stability gate. The live page is a moving
// target (resizes, animations, sibling agents) — a capture only counts if
// the page state provably held still across it.
import { writeFileSync } from "node:fs";
import { evaluate } from "./cdp.mjs";

// probeExpr: page-side expression returning a JSON string of everything
// that must hold still — target rects, innerWidth/innerHeight, dynamic
// texts, document.fonts.status. Build it per capture.
export async function stableShot(page, probeExpr, outPath, clip) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const before = await evaluate(page, probeExpr);
    await new Promise((r) => setTimeout(r, 350));
    const again = await evaluate(page, probeExpr);
    if (again !== before) continue;
    const params = {};
    if (clip) params.clip = { ...clip, scale: 1 };
    const shot = await page.send("Page.captureScreenshot", params);
    const after = await evaluate(page, probeExpr);
    if (after !== before) continue;
    writeFileSync(outPath, Buffer.from(shot.data, "base64"));
    return JSON.parse(before);
  }
  throw new Error("page never held still across a capture");
}

// Standard probe pieces to concatenate into probeExpr.
export const FONTS_LOADED = `document.fonts.status`;
export const VIEWPORT = `[innerWidth, innerHeight]`;
export const rectOf = (selector) =>
  `(r => [r.x, r.y, r.width, r.height])(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`;
