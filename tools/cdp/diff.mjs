// Pixel diff of two captures, in node: no tab, no server, no canvas.
// The numbers and clusters are what to debug from, never the red map
// by eye. `tools/verify-replica.mjs` is the one-shot that captures
// both sides and calls this.
import { readFileSync, writeFileSync } from "node:fs";
import { decodePng, encodePng } from "./png.mjs";

export const THRESHOLD = 8;

/**
 * Compare two PNGs at `threshold` (max channel delta that still
 * counts as equal). Writes the diff image (the real capture with
 * every disagreeing pixel painted red) to `diffPath` when given.
 * `ignore(x, y)` names device pixels that are not the element's own
 * (outside its rounded corners, where the page shows through): they
 * are neither counted nor painted.
 * -> { width, height, diffPixels, pct, maxDelta, clusters, bad }
 *    clusters: bounding boxes of the disagreeing regions, largest
 *    first, in CSS px at `dpr`; bad: one byte per pixel, 1 where the
 *    two disagree.
 */
export function diffPngs(realPath, minePath, { diffPath, threshold = THRESHOLD, dpr = 2, ignore = null } = {}) {
  const real = decodePng(readFileSync(realPath));
  const mine = decodePng(readFileSync(minePath));
  const width = Math.min(real.width, mine.width);
  const height = Math.min(real.height, mine.height);
  const out = new Uint8Array(width * height * 4);
  const bad = new Uint8Array(width * height);
  let diffPixels = 0;
  let maxDelta = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = (y * real.width + x) * 4;
      const b = (y * mine.width + x) * 4;
      const o = (y * width + x) * 4;
      const delta = Math.max(
        Math.abs(real.data[a] - mine.data[b]),
        Math.abs(real.data[a + 1] - mine.data[b + 1]),
        Math.abs(real.data[a + 2] - mine.data[b + 2]),
      );
      const own = ignore === null || !ignore(x, y);
      if (own) maxDelta = Math.max(maxDelta, delta);
      if (own && delta > threshold) {
        diffPixels += 1;
        bad[y * width + x] = 1;
        out[o] = 255;
        out[o + 1] = 0;
        out[o + 2] = 0;
      } else {
        out[o] = real.data[a];
        out[o + 1] = real.data[a + 1];
        out[o + 2] = real.data[a + 2];
      }
      out[o + 3] = 255;
    }
  }
  if (diffPath) writeFileSync(diffPath, encodePng({ width, height, data: out }));
  return {
    width,
    height,
    sizeReal: [real.width, real.height],
    sizeMine: [mine.width, mine.height],
    threshold,
    diffPixels,
    pct: ((100 * diffPixels) / (width * height)).toFixed(2) + "%",
    maxDelta,
    clusters: clusters(bad, width, height, dpr),
    bad,
  };
}

// Disagreeing pixels grouped into boxes 20 device px apart, largest
// first, at most twelve: a thin full-width strip at a clip edge means
// the clip includes a neighbour; a box the size of the glyphs means
// text; one the size of the element means position.
function clusters(bad, width, height, dpr) {
  const boxes = [];
  const near = (x, y) => boxes.find((b) => x >= b.x0 - 20 && x <= b.x1 + 20 && y >= b.y0 - 20 && y <= b.y1 + 20);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!bad[y * width + x]) continue;
      let box = near(x, y);
      if (!box) {
        box = { x0: x, y0: y, x1: x, y1: y, n: 0 };
        boxes.push(box);
      }
      box.x0 = Math.min(box.x0, x);
      box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
      box.n += 1;
    }
  }
  boxes.sort((p, q) => q.n - p.n);
  return boxes.slice(0, 12).map((b) => ({
    cssRect: [b.x0 / dpr, b.y0 / dpr, (b.x1 - b.x0 + 1) / dpr, (b.y1 - b.y0 + 1) / dpr],
    px: b.n,
  }));
}
