/** Readiness for generated previews only. Never navigates a source URL. */
import { evaluate } from './cdp.mjs';

export class RenderError extends Error {
  constructor(message, diagnostics = []) { super(message); this.name = 'RenderError'; this.diagnostics = diagnostics; }
}
export async function observeRender(page) {
  const errors = [];
  await Promise.all([page.send('Runtime.enable'), page.send('Network.enable'), page.send('Log.enable')]);
  page.on('Runtime.exceptionThrown', p => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
  page.on('Runtime.consoleAPICalled', p => { if (p.type === 'error') errors.push(p.args.map(a => a.value ?? a.description ?? '').join(' ')); });
  const required = new Set(['Document', 'Script', 'Stylesheet', 'Image', 'Font']);
  page.on('Network.responseReceived', p => { if (required.has(p.type) && p.response.status >= 400) errors.push(`${p.type}: HTTP ${p.response.status} ${p.response.url}`); });
  page.on('Network.loadingFailed', p => { if (required.has(p.type) && !p.canceled) errors.push(`${p.type}: ${p.errorText}`); });
  return errors;
}
export async function waitForGenerated(page, { markers = [], uniqueMarkers = false, errors = [], timeoutMs = 30000, startedAt = Date.now() } = {}) {
  const deadline = startedAt + timeoutMs;
  let previous = null; let stable = 0; let last;
  while (Date.now() < deadline) {
    if (errors.length) throw new RenderError('Generated preview failed to render.', [...errors]);
    last = await evaluate(page, `(() => {
      const root = document.querySelector('#root, #app');
      const ids = ${JSON.stringify(markers)};
      const nodes = Array.from(document.querySelectorAll('[data-proto-id]'));
      const counts = {}; for (const node of nodes) { const id=node.getAttribute('data-proto-id'); counts[id]=(counts[id]||0)+1; }
      const imgs = Array.from(document.images).filter(img => img.getClientRects().length);
      const broken = imgs.filter(img => img.complete && !img.naturalWidth).map(img => img.currentSrc || img.src);
      // Starting decode after mount also discovers fonts introduced by lazy components.
      for (const img of imgs) { img.loading='eager'; const src=img.currentSrc || img.src; if (img.dataset.protoDecoded!==src && img.complete && img.naturalWidth) img.decode().then(() => img.dataset.protoDecoded=src).catch(() => {}); }
      const rect = el => { const r=el.getBoundingClientRect(); return [r.x,r.y,r.width,r.height].map(n=>Math.round(n*100)/100); };
      return { mounted: !!root?.children.length && nodes.length > 0, markers: counts, missing: ids.filter(id=>!counts[id] || (${JSON.stringify(uniqueMarkers)} && counts[id]!==1)),
        resources: document.fonts.status === 'loaded' && imgs.every(img=>img.complete && img.dataset.protoDecoded===(img.currentSrc || img.src)), broken,
        bounds: [document.documentElement.scrollWidth, document.documentElement.scrollHeight, ...nodes.map(rect)] };
    })()`, { timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) });
    if (last.broken.length) throw new RenderError('Required preview images failed to load.', last.broken);
    const key = JSON.stringify(last.bounds);
    if (last.mounted && last.missing.length === 0 && last.resources) stable = key === previous ? stable + 1 : 1;
    else stable = 0;
    previous = key;
    if (errors.length) throw new RenderError('Generated preview failed to render.', [...errors]);
    if (stable >= 3) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new RenderError('Generated preview did not become ready within the deadline.', [JSON.stringify(last)]);
}
