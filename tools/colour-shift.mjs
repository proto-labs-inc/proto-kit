/**
 * Whether two captures of one component differ by a colour, not by a
 * shape: the product's picture and ours compared pixel for pixel, and
 * the colour that fills most of ours looked up at the same spots in
 * theirs. A button drawn a different blue differs in nearly every
 * pixel while every edge, glyph and size agrees; no box, margin or
 * attribute explains that, and a diagnosis that names one sends a unit
 * after the wrong value (tools/explain-diff.mjs).
 *
 * Pure: works on decoded PNGs ({ width, height, data } as
 * tools/cdp/png.mjs decodes them), so it is tested on synthetic ones.
 */

/** Largest channel difference between two [r, g, b, …] colours. */
export const channelDelta = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));

export const rgbText = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

/**
 * The colour shift between `live` and `ours` over `region` (device px,
 * [x, y, width, height]; the whole overlap when omitted), or null when
 * there is none:
 *   { live, ours, delta, share, agree, differing, explained, uniform, pairs }
 * - `ours` is the colour that fills most of our capture, `live` the one
 *   the product's capture shows at those same pixels, `delta` live
 *   minus ours per channel;
 * - `share` the region's fraction those pixels cover, `agree` the
 *   fraction of them where the product shows that one colour (a
 *   shifted shape scatters it, a recoloured box keeps it);
 * - `differing` the pixels over `threshold`, `explained` the fraction
 *   of them the shift accounts for;
 * - `pairs` every colour filling at least 3% of ours with the colour
 *   theirs shows there, and `uniform` whether every such pair that
 *   moved moved the same way (the whole box darker, or lighter).
 */
export function colourShift(live, ours, region = null, { threshold = 8 } = {}) {
  const width = Math.min(live.width, ours.width);
  const height = Math.min(live.height, ours.height);
  const [rx, ry, rw, rh] = region ?? [0, 0, width, height];
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(width, Math.ceil(rx + rw));
  const y1 = Math.min(height, Math.ceil(ry + rh));
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  if (area === 0) return null;
  const at = (img, x, y) => {
    const i = (y * img.width + x) * 4;
    return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
  };
  const keyOf = (c) => `${c[0]},${c[1]},${c[2]}`;
  const parse = (k) => k.split(",").map(Number);

  // Every exact colour of ours, with the product's colours at its pixels.
  const byOurs = new Map();
  let differing = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const o = at(ours, x, y);
      const l = at(live, x, y);
      if (channelDelta(o, l) > threshold) differing++;
      const k = keyOf(o);
      let entry = byOurs.get(k);
      if (!entry) byOurs.set(k, (entry = { count: 0, theirs: new Map() }));
      entry.count++;
      const lk = keyOf(l);
      entry.theirs.set(lk, (entry.theirs.get(lk) ?? 0) + 1);
    }
  }
  // Near colours (antialiasing, a level of dither) count with the exact one.
  const near = (k, map) => {
    const c = parse(k);
    let total = 0;
    for (const [other, n] of map) if (channelDelta(c, parse(other)) <= 2) total += n;
    return total;
  };
  const counts = new Map([...byOurs].map(([k, e]) => [k, e.count]));
  const ranked = [...byOurs.keys()].sort((a, b) => byOurs.get(b).count - byOurs.get(a).count);
  const pairOf = (k) => {
    // Pool the product's colours over every near shade of this one of ours.
    const c = parse(k);
    const theirs = new Map();
    let count = 0;
    for (const [other, e] of byOurs) {
      if (channelDelta(c, parse(other)) > 2) continue;
      count += e.count;
      for (const [lk, n] of e.theirs) theirs.set(lk, (theirs.get(lk) ?? 0) + n);
    }
    // The product's most common colour there (its near shades pooled), from its few most common exact ones.
    const candidates = [...theirs.keys()].sort((a, b) => theirs.get(b) - theirs.get(a)).slice(0, 8);
    let top = candidates[0];
    let best = -1;
    for (const k of candidates) {
      const n = near(k, theirs);
      if (n > best) [top, best] = [k, n];
    }
    return { ours: c, live: parse(top), count, agree: best / count };
  };
  if (ranked.length === 0) return null;
  const main = pairOf(ranked[0]);
  const share = near(ranked[0], counts) / area;
  const delta = [main.live[0] - main.ours[0], main.live[1] - main.ours[1], main.live[2] - main.ours[2]];
  if (channelDelta(main.live, main.ours) <= threshold || share < 0.25 || main.agree < 0.75) return null;

  // The other colours that fill a part of ours, and what theirs shows there.
  const pairs = [main];
  const seen = [main.ours];
  for (const k of ranked.slice(1)) {
    const c = parse(k);
    if (seen.some((s) => channelDelta(s, c) <= 2)) continue;
    if (near(k, counts) < 0.03 * area) break;
    seen.push(c);
    pairs.push(pairOf(k));
  }
  const sign = (n) => (n > 2 ? 1 : n < -2 ? -1 : 0);
  const moved = pairs.filter((p) => channelDelta(p.live, p.ours) > threshold);
  const direction = (p) => Math.sign(p.live[0] + p.live[1] + p.live[2] - (p.ours[0] + p.ours[1] + p.ours[2]));
  const uniform = moved.length > 0 && moved.every((p) => direction(p) === direction(main)) && delta.every((d, i) => moved.every((p) => sign(p.live[i] - p.ours[i]) === 0 || sign(p.live[i] - p.ours[i]) === sign(d) || sign(d) === 0));
  const explainedPixels = moved.reduce((n, p) => n + p.count * p.agree, 0);
  return {
    live: main.live.slice(0, 3),
    ours: main.ours.slice(0, 3),
    delta,
    share: round(share),
    agree: round(main.agree),
    differing,
    explained: differing === 0 ? 0 : round(Math.min(1, explainedPixels / differing)),
    uniform,
    pairs: pairs.map((p) => ({ ours: p.ours.slice(0, 3), live: p.live.slice(0, 3), share: round(p.count / area), agree: round(p.agree) })),
  };
}

const round = (n) => Math.round(n * 1000) / 1000;
