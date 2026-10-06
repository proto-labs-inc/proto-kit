import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const readJson = (path, fallback = null) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
export function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
const excluded = new Set(['node_modules', 'dist', '.git', '.vite', '.proto-checks', 'previews']);
export function fingerprint(root, { output = false } = {}) {
  const digest = createHash('sha256');
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      if (!output && (excluded.has(entry.name) || entry.name.endsWith('.tsbuildinfo') || entry.name.startsWith('.proto-'))) continue;
      const key = prefix + entry.name; const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path, key + '/'); continue; }
      if (entry.isSymbolicLink()) throw new Error(`Fingerprint requires copied source assets, not symlinks: ${key}`);
      if (!entry.isFile()) continue;
      let bytes = readFileSync(path);
      if (!output && key === 'public/prototype.json') {
        const manifest = JSON.parse(bytes);
        for (const set of manifest.variantSets ?? []) {
          delete set.status;
          for (const variant of set.variants ?? []) { delete variant.preview; delete variant.previewBackground; }
        }
        bytes = Buffer.from(JSON.stringify(manifest));
      }
      digest.update(key + '\0'); digest.update(String(bytes.length) + '\0'); digest.update(bytes);
    }
  }
  walk(root); return digest.digest('hex');
}
export function lockBuild(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'runner.lock'); const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const previous = readJson(path);
      if (!Number.isInteger(previous?.pid)) throw new Error('Build lock is invalid; inspect it before recovery.');
      try { process.kill(previous.pid, 0); throw new Error('This brief already has an active runner.'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
      if (readJson(path)?.token !== previous.token) throw new Error('Build lock changed during recovery. Retry.');
      unlinkSync(path);
    }
  }
  if (readJson(path)?.token !== token) throw new Error('Unable to acquire build lock.');
  return () => { if (readJson(path)?.token === token) unlinkSync(path); };
}
export function checkpoint(dir, identity) {
  const path = join(dir, 'runner.json');
  const state = readJson(path, { schemaVersion: 1, ...identity, stages: {}, timings: [] });
  if (state.schemaVersion !== 1 || state.briefId !== identity.briefId || state.codebase !== identity.codebase) throw new Error('Runner checkpoint does not match this request.');
  const save = () => writeJson(path, state);
  const measure = async (kind, name, operation) => {
    const start = Date.now();
    try { return await operation(); }
    finally { state.timings.push({ kind, name, startedAt: new Date(start).toISOString(), ms: Date.now() - start }); save(); }
  };
  if (state.waiting) { state.timings.push({ kind: state.waiting.kind, name: state.waiting.stage, ms: Date.now() - state.waiting.since }); delete state.waiting; save(); }
  return { state, save, measure };
}
