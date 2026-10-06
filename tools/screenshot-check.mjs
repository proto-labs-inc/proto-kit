/** Verify only the local prototype, against an immutable full-page screenshot. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { headlessPage } from './cdp/headless.mjs';
import { evaluate } from './cdp/cdp.mjs';
import { decodePng, encodePng, cropPng } from './cdp/png.mjs';
import { diffPngs } from './cdp/diff.mjs';
import { ensureDevServer } from './dev-server.mjs';
import { TAIL } from './tail.mjs';

/** Agent-authored mapping of screenshot regions to real source files, not a source DOM. */
export function validateComponentMap(map, reference, sourcePath) {
  if (!Array.isArray(map?.parts) || !map.parts.length) throw new Error('Map the screenshot regions to source components in components.json before checking.');
  const seen = new Set();
  for (const part of map.parts) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(part.marker) || part.marker.length > 80 || seen.has(part.marker)) throw new Error('Every component needs a unique stable data-proto-id marker.');
    seen.add(part.marker);
    if (part.role !== undefined && !["section", "leaf"].includes(part.role)) throw new Error("A mapped region is a section or a leaf component.");
    if (typeof part.name !== 'string' || !part.name.trim() || part.name.length > 80) throw new Error('Every component needs a meaningful name of at most 80 characters.');
    if (!Array.isArray(part.sourceFiles) || !part.sourceFiles.length) throw new Error(`Name source files for ${part.marker}.`);
    for (const file of part.sourceFiles) {
      const path = resolve(sourcePath, file); const rel = relative(sourcePath, path);
      if (isAbsolute(file) || rel.startsWith('..') || isAbsolute(rel) || !existsSync(path)) throw new Error(`Missing source component: ${file}`);
    }
    const r = part.rect;
    if (!r || !['x','y','w','h'].every(k => Number.isInteger(r[k])) || r.x < 0 || r.y < 0 || r.w <= 0 || r.h <= 0 || r.x + r.w > reference.width || r.y + r.h > reference.height) throw new Error(`Invalid screenshot region for ${part.marker}. Use image pixel coordinates.`);
  }
  return map;
}

export function compareScreenshot({ runDir, reference, capture, parts, mounted, markers }) {
  const baseline = join(runDir, 'reference.png');
  const actual = decodePng(readFileSync(capture));
  const expected = decodePng(readFileSync(baseline));
  // Never let the shared diff's overlap-only comparison hide clipped/extra content.
  const dimensionsMatch = actual.width === expected.width && actual.height === expected.height;
  const result = diffPngs(baseline, capture, { diffPath: join(runDir, 'copy-diff.png') });
  const pct = Number.parseFloat(result.pct);
  const checked = parts.map(part => {
    const r = part.rect;
    const clip = { x: r.x, y: r.y, width: r.w, height: r.h };
    const target = join(runDir, `${part.marker}-reference.png`);
    const mine = join(runDir, `${part.marker}-copy.png`);
    let status = 'differs'; let mismatch = r.w * r.h;
    if (r.x + r.w <= actual.width && r.y + r.h <= actual.height) {
      writeFileSync(target, encodePng(cropPng(expected, clip)));
      writeFileSync(mine, encodePng(cropPng(actual, clip)));
      mismatch = diffPngs(target, mine).diffPixels;
      if (markers[part.marker] === 1 && 100 * mismatch / (r.w * r.h) <= TAIL.PAGE_PROCEED_PCT) status = 'matched';
    }
    return { ...part, id: part.marker, slug: part.marker, status, mismatch, image: existsSync(mine) ? mine : null };
  });
  const markersMatch = checked.every(part => markers[part.marker] === 1);
  const proceed = mounted && dimensionsMatch && markersMatch && pct <= TAIL.PAGE_PROCEED_PCT;
  const line = `Screenshot difference: ${result.pct}.${dimensionsMatch ? '' : ' Page dimensions differ.'}${mounted ? '' : ' Prototype did not mount.'}${markersMatch ? '' : ' Component markers are missing or duplicated.'}`;
  return { parts: checked, gate: { proceed, line }, page: { pct, dimensionsMatch, mounted, markersMatch, screenshot: capture, diff: join(runDir, 'copy-diff.png') } };
}

export async function checkScreenshot({ runDir, reference, workspace, parts, keep = false }) {
  const dev = await ensureDevServer({ workspace, logPath: join(runDir, 'dev.log'), keep });
  let tab;
  try {
    // A screenshot does not record browser viewport height or DPR. The default is
    // one image pixel per CSS pixel and a viewport as tall as the supplied image.
    tab = await headlessPage(dev.url, { width: reference.width, height: reference.height, display: { dpr: 1, colorProfile: 'srgb' }, generated: true, uniqueMarkers: true, markers: parts.map(part => part.marker) });
    await evaluate(tab.page, `Promise.all(Array.from(document.images, img => img.decode().catch(() => {})))`);
    const state = await evaluate(tab.page, `(() => {
      const root = document.querySelector('#root, #app');
      const markers = {}; for (const el of document.querySelectorAll('[data-proto-id]')) { const id = el.getAttribute('data-proto-id'); markers[id] = (markers[id] || 0) + 1; }
      return { mounted: !!root?.children.length, markers, width: Math.max(innerWidth, document.documentElement.scrollWidth), height: Math.max(innerHeight, document.documentElement.scrollHeight) };
    })()`);
    if (state.width > 10000 || state.height > 40000 || state.width * state.height > 40000000) throw new Error('Generated page exceeds screenshot comparison limits.');
    const shot = await tab.page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: state.width, height: state.height, scale: 1 } });
    const capture = join(runDir, 'copy.png'); writeFileSync(capture, Buffer.from(shot.data, 'base64'));
    return compareScreenshot({ runDir, reference, capture, parts, ...state });
  } finally { if (tab) await tab.close(); dev.stop(); }
}
