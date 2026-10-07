import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const version = '0.1.0+codex.20261007220000';
test('offline check handles current, newer, older, unknown, missing and unverified installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'proto-check-'));
  const run = required => JSON.parse(execFileSync(process.execPath, ['tools/check-plugin.cjs', root, required], { encoding: 'utf8', env: { PATH: '' } }));
  try {
    assert.equal(run(version).status, 'update_needed');
    mkdirSync(join(root, '.codex-plugin'));
    writeFileSync(join(root, '.codex-plugin/plugin.json'), JSON.stringify({ version }));
    assert.equal(run(version).status, 'update_needed');
    writeFileSync(join(root, '.proto-release.json'), JSON.stringify({ version }));
    assert.equal(run(version).status, 'current');
    assert.equal(run('0.1.0+codex.20261006220000').status, 'current');
    assert.equal(run('0.1.0+codex.20261008220000').status, 'update_needed');
    assert.equal(run('unknown').status, 'update_needed');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
