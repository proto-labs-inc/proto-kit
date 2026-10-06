/** Screenshot bytes are immutable evidence. The source URL is never fetched. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './cdp/png.mjs';
import { headlessPage } from './cdp/headless.mjs';
import { evaluate } from './cdp/cdp.mjs';

export function httpReference(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('A valid HTTP(S) screen URL is required.');
  return url.href;
}

/** Decode all supported uploads without changing the original file. Browser only sees inline bytes. */
export async function normalizeImage(bytes, type) {
  if (type === 'image/png') {
    try { decodePng(bytes); return bytes; } catch { /* Browser decodes indexed/interlaced PNG too. */ }
  }
  const tab = await headlessPage('about:blank', { width: 1, height: 1, display: { dpr: 1, colorProfile: 'srgb' } });
  try {
    const data = `data:${type};base64,${bytes.toString('base64')}`;
    const png = await evaluate(tab.page, `(async () => {
      const img = new Image(); img.src = ${JSON.stringify(data)}; await img.decode();
      if (!img.width || !img.height || img.width > 10000 || img.height > 40000 || img.width * img.height > 40000000) throw new Error('Screenshot dimensions exceed the comparison limit.');
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0); return canvas.toDataURL('image/png').split(',')[1];
    })()`);
    if (typeof png !== 'string') throw new Error('The screenshot could not be decoded. Ask for a readable PNG, JPEG, or WebP image.');
    return Buffer.from(png, 'base64');
  } finally { await tab.close(); }
}

export async function prepareReference({ runDir, referenceUrl, referenceImage, fetchImage = fetch, normalize = normalizeImage }) {
  const url = httpReference(referenceUrl);
  const image = httpReference(referenceImage);
  const recordPath = join(runDir, 'reference.json');
  if (existsSync(recordPath)) {
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    if (record.url !== url || record.image !== image) throw new Error('This checkpoint belongs to different references. Preserve the brief and resolve the change before continuing.');
    const original = readFileSync(join(runDir, record.original));
    if (createHash('sha256').update(original).digest('hex') !== record.sha256) throw new Error('The saved reference screenshot changed. Restore the original before continuing.');
    if (createHash('sha256').update(readFileSync(join(runDir, 'reference.png'))).digest('hex') !== record.pngSha256) throw new Error('The comparison image changed. Restore the checkpoint before continuing.');
    return record;
  }
  const response = await fetchImage(image, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`The screenshot could not be downloaded (${response.status}). Ask for a readable screenshot, not a source-page login.`);
  const type = response.headers.get('content-type')?.split(';')[0];
  const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
  if (!extensions[type]) throw new Error('The reference must be a PNG, JPEG, or WebP screenshot.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 3 * 1024 * 1024) throw new Error('The reference screenshot must be at most 3 MB.');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw new Error('The reference screenshot is empty.');
  const png = await normalize(bytes, type);
  const { width, height } = decodePng(png);
  if (width > 10000 || height > 40000 || width * height > 40000000) throw new Error('Screenshot dimensions exceed the comparison limit.');
  mkdirSync(runDir, { recursive: true });
  const original = `reference-original.${extensions[type]}`;
  writeFileSync(join(runDir, original), bytes);
  writeFileSync(join(runDir, 'reference.png'), png);
  const record = { kind: 'screenshot', url, image, original, width, height, sha256: createHash('sha256').update(bytes).digest('hex'), pngSha256: createHash('sha256').update(png).digest('hex') };
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
  return record;
}
