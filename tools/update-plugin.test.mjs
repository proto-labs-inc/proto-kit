import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updatePlugin } from './update-plugin.mjs';
const v = '0.1.0+codex.20261007220000';
function put(root, version = v) { mkdirSync(join(root, '.codex-plugin'), { recursive: true }); writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ version })); }
for (const host of ['codex', 'claude']) test(`${host} migrates local registration and verifies the actual copy`, () => {
  const home = mkdtempSync(join(tmpdir(), 'proto-test-')); const calls = [];
  const root = host === 'codex' ? join(home, '.codex/plugins/cache/proto-kit/proto', v) : join(home, 'claude-installed');
  put(root);
  try {
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'clone') put(args.at(-1));
      if (args.join(' ') === 'plugin marketplace list --json') return JSON.stringify(host === 'codex' ? { marketplaces: [{ name: 'proto-kit', marketplaceSource: { sourceType: 'local' } }] } : [{ name: 'proto-kit', source: 'directory' }]);
      if (args[1] === 'list') return JSON.stringify(host === 'codex' ? { installed: [{ pluginId: 'proto@proto-kit', version: v }] } : [{ id: 'proto@proto-kit', installPath: root }]);
      return '';
    };
    assert.equal(updatePlugin(host, { run, home, codexHome: join(home, '.codex') }).installedRoot, root);
    assert.ok(calls.some(c => c.join(' ').includes('marketplace remove proto-kit')));
    assert.ok(calls.some(c => c.join(' ').includes(host === 'codex' ? '--ref release' : 'proto-kit#release')));
    assert.equal(calls.some(c => c.includes('main')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('unavailable release fails before any host mutation', () => {
  const calls = [];
  assert.throws(() => updatePlugin('codex', { run(cmd) { calls.push(cmd); throw new Error('offline'); } }), /offline/);
  assert.deepEqual(calls, ['git']);
});
test('dirty Cursor checkout is preserved', () => {
  const home = mkdtempSync(join(tmpdir(), 'proto-test-')); put(join(home, '.cursor/plugins/local/proto')); const calls = [];
  try {
    assert.throws(() => updatePlugin('cursor', { home, run(cmd, args) { calls.push(args); if (args[0] === 'clone') put(args.at(-1)); if (args.includes('--porcelain')) return ' M file'; return ''; } }), /local edits; preserved/);
    assert.equal(calls.some(c => c.includes('checkout') || c.includes('fetch')), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('unknown harness is rejected without execution', () => assert.throws(() => updatePlugin('unknown'), /Pass --agent/));
