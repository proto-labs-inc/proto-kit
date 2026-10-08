import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
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
for (const host of ['codex', 'claude']) test(`${host} installs a branch build from preview/<branch>`, () => {
  const home = mkdtempSync(join(tmpdir(), 'proto-test-')); const calls = [];
  const root = host === 'codex' ? join(home, '.codex/plugins/cache/proto-kit/proto', v) : join(home, 'claude-installed');
  const branchBuild = dir => { put(dir); writeFileSync(join(dir, '.proto-release.json'), JSON.stringify({ version: v, channel: 'sketch-first' })); };
  branchBuild(root);
  try {
    const run = (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'git' && args[0] === 'clone') branchBuild(args.at(-1));
      if (args.join(' ') === 'plugin marketplace list --json') return JSON.stringify(host === 'codex' ? { marketplaces: [] } : []);
      if (args[1] === 'list') return JSON.stringify(host === 'codex' ? { installed: [{ pluginId: 'proto@proto-kit', version: v }] } : [{ id: 'proto@proto-kit', installPath: root }]);
      return '';
    };
    const result = updatePlugin(host, { run, home, codexHome: join(home, '.codex'), channel: 'sketch-first' });
    assert.equal(result.branch, 'sketch-first');
    assert.ok(calls.some(c => c.join(' ') === 'git clone --depth 1 --single-branch --branch preview/sketch-first https://github.com/proto-labs-inc/proto-kit.git ' + c.at(-1)));
    assert.ok(calls.some(c => c.join(' ').includes(host === 'codex' ? '--ref preview/sketch-first' : 'proto-kit#preview/sketch-first')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('an install that turns out to be another branch is not verified', () => {
  const home = mkdtempSync(join(tmpdir(), 'proto-test-')); const root = join(home, 'claude-installed'); put(root);
  try {
    const run = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'clone') put(args.at(-1));
      if (args.join(' ') === 'plugin marketplace list --json') return '[]';
      if (args[1] === 'list') return JSON.stringify([{ id: 'proto@proto-kit', installPath: root }]);
      return '';
    };
    assert.throws(() => updatePlugin('claude', { run, home, channel: 'sketch-first' }), /build of main, expected sketch-first/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('Cursor moves from a branch build back to release once that build is on its preview branch', () => {
  const home = mkdtempSync(join(tmpdir(), 'proto-test-')); const root = join(home, '.cursor/plugins/local/proto'); const calls = [];
  put(root); writeFileSync(join(root, '.proto-release.json'), JSON.stringify({ version: v, channel: 'sketch-first' }));
  try {
    const run = (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'clone') put(args.at(-1));
      if (args.includes('checkout')) writeFileSync(join(root, '.proto-release.json'), JSON.stringify({ version: v }));
      if (args.includes('get-url')) return 'https://github.com/proto-labs-inc/proto-kit.git';
      return '';
    };
    assert.equal(updatePlugin('cursor', { run, home }).branch, 'main');
    const fetches = calls.filter(c => c.includes(' fetch '));
    assert.deepEqual(fetches.map(c => c.split(' ').at(-1)), ['preview/sketch-first', 'release']);
    assert.ok(calls.indexOf(fetches[0]) < calls.findIndex(c => c.includes('merge-base')));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
test('unsafe branch names are refused before anything runs', () => {
  const calls = [];
  for (const channel of ['../x', 'x;rm -rf', 'preview/x', 'release']) assert.throws(() => updatePlugin('claude', { channel, run(cmd) { calls.push(cmd); return ''; } }), /--branch/);
  assert.deepEqual(calls, []);
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


test('CLI runs through a symlinked temporary directory instead of silently succeeding', () => {
  const temp = mkdtempSync(join(tmpdir(), 'proto-launch-'));
  try {
    const actual = join(temp, 'actual folder');
    const alias = join(temp, 'alias folder');
    mkdirSync(actual);
    copyFileSync(new URL('./update-plugin.mjs', import.meta.url), join(actual, 'update.mjs'));
    symlinkSync(actual, alias, 'dir');
    for (const directory of [actual, alias]) {
      // Invalid host reaches CLI validation without network or plugin mutations.
      const result = spawnSync(process.execPath, [join(directory, 'update.mjs'), '--agent', 'invalid'], { encoding: 'utf8' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Proto update failed: Pass --agent/);
      assert.equal(result.stdout, '');
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
