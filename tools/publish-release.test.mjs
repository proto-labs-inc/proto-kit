import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRelease, releaseVersion } from './publish-release.mjs';

test('generated version advances across retries, clock skew and midnight', () => {
  assert.equal(releaseVersion('0.1.0+codex.20261007235959', new Date('2026-10-07T00:00:00Z')), '0.1.0+codex.20261008000000');
  assert.throws(() => releaseVersion('invalid'), /Invalid/);
});

test('release snapshots preserve source, reuse retries, advance without manual bumps and reject stale source', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'proto-release-test-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q'); git('config', 'user.email', 'test@example.test'); git('config', 'user.name', 'Test');
  for (const path of ['.codex-plugin', '.cursor-plugin']) mkdirSync(join(cwd, path));
  for (const path of ['.codex-plugin/plugin.json', '.cursor-plugin/plugin.json', 'plugin.json']) writeFileSync(join(cwd, path), JSON.stringify({ name: 'proto', version: '0.1.0+codex.20261001000000' }));
  writeFileSync(join(cwd, 'code.txt'), 'one'); git('add', '.'); git('commit', '-qm', 'first');
  const remote = join(cwd, 'remote.git');
  git('init', '--bare', '-q', remote);
  const source = git('rev-parse', 'HEAD');
  const first = prepareRelease({ cwd, source, runId: 1, now: new Date('2026-10-07T00:00:00Z') });
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
  git('push', '-q', remote, `${first.commit}:refs/heads/release`);
  assert.equal(git('show', `${first.commit}:code.txt`), 'one');
  assert.equal(JSON.parse(git('show', `${first.commit}:plugin.json`)).version, first.version);
  assert.equal(JSON.parse(git('show', `${source}:plugin.json`)).version, '0.1.0+codex.20261001000000');
  assert.equal(prepareRelease({ cwd, source, previous: first.commit, runId: 2 }).commit, first.commit);
  writeFileSync(join(cwd, 'code.txt'), 'two'); git('add', 'code.txt'); git('commit', '-qm', 'second, no version bump');
  const second = prepareRelease({ cwd, source: 'HEAD', previous: first.commit, runId: 3, now: new Date('2026-10-06T00:00:00Z') });
  assert.ok(second.version > first.version);
  git('push', '-q', remote, `${second.commit}:refs/heads/release`);
  const competing = prepareRelease({ cwd, source: 'HEAD', previous: first.commit, runId: 5, now: new Date('2026-10-08T00:00:00Z') });
  assert.throws(() => git('push', '-q', remote, `${competing.commit}:refs/heads/release`));
  assert.ok(git('ls-remote', remote, 'refs/heads/release').startsWith(second.commit));
  git('merge-base', '--is-ancestor', first.commit, second.commit);
  assert.equal(git('show', `${second.commit}:code.txt`), 'two');
  assert.throws(() => prepareRelease({ cwd, source, previous: second.commit, runId: 4 }));
  assert.equal(git('status', '--porcelain', '--untracked-files=no'), '');
});
