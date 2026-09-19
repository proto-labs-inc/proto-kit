// Pixel diffing runs in a browser tab. The canvas decodes the images and
// compares them. This module builds the URL and holds the read expressions.
//
// Steps:
// 1. Start the server: node tools/serve.mjs <workdir> 8123
// 2. Open (background tab or worker-tab navigation): diffUrl("real.png", "mine.png")
// 3. Read the numbers: evaluate(page, DIFF_NUMBERS)
// 4. Debug from clusters: evaluate(page, CLUSTERS)

export function diffUrl(realPng, minePng, base = "http://localhost:8123") {
  return `${base}/tools/cdp/diff.html?a=${encodeURIComponent(realPng)}&b=${encodeURIComponent(minePng)}`;
}

// -> '{"diffPixels":..,"pct":"..","maxDelta":..}'
// The same numbers twice across an iteration means the input did not change.
// That is a stale tab or a raced capture, not a stubborn page.
export const DIFF_NUMBERS = `document.getElementById("out").textContent`;

// Poll the diff page until it reports numbers. Tolerates the tab still
// parsing (evaluate throws) and the images still loading ("loading").
export async function readDiff(page, evaluate, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const out = await evaluate(page, DIFF_NUMBERS);
      if (out !== "loading") return JSON.parse(out);
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("diff page never produced numbers");
}

// -> bounding boxes of the differing regions, in CSS px, largest first.
// Debug from these numbers. Do not debug from the red map by eye.
export const CLUSTERS = `(() => {
  const a = document.getElementById("a"), b = document.getElementById("b");
  const w = a.naturalWidth, h = a.naturalHeight;
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(a, 0, 0); const pa = ctx.getImageData(0, 0, w, h).data;
  ctx.drawImage(b, 0, 0); const pb = ctx.getImageData(0, 0, w, h).data;
  const boxes = [];
  const near = (x, y) => boxes.find(bx => x >= bx.x0 - 20 && x <= bx.x1 + 20 && y >= bx.y0 - 20 && y <= bx.y1 + 20);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const d = Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i+1] - pb[i+1]), Math.abs(pa[i+2] - pb[i+2]));
    if (d > 8) {
      let bx = near(x, y);
      if (!bx) { bx = { x0: x, y0: y, x1: x, y1: y, n: 0, maxD: 0 }; boxes.push(bx); }
      bx.x0 = Math.min(bx.x0, x); bx.x1 = Math.max(bx.x1, x);
      bx.y0 = Math.min(bx.y0, y); bx.y1 = Math.max(bx.y1, y);
      bx.n++; bx.maxD = Math.max(bx.maxD, d);
    }
  }
  boxes.sort((p, q) => q.n - p.n);
  return JSON.stringify(boxes.slice(0, 12).map(bx => ({
    cssRect: [bx.x0/2, bx.y0/2, (bx.x1-bx.x0)/2, (bx.y1-bx.y0)/2],
    px: bx.n, maxDelta: bx.maxD
  })));
})()`;
