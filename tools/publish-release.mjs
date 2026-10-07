#!/usr/bin/env node
/** Build a generated release commit without changing the source checkout. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseVersion(previous, now = new Date()) {
  let millis = now.getTime();
  if (previous) {
    const match = /^0\.1\.0\+codex\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(previous);
    if (!match) throw new Error('Invalid previous release version');
    const [, y, m, d, hh, mm, ss] = match;
    millis = Math.max(millis, Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss) + 1000);
  }
  return '0.1.0+codex.' + new Date(millis).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function prepareRelease({ cwd, source, previous, runId, now }) {
  const temp = mkdtempSync(join(tmpdir(), 'proto-release-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(temp, 'index'),
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' };
  const git = (args, input) => execFileSync('git', args, { cwd, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const read = (ref, path) => JSON.parse(git(['show', `${ref}:${path}`]));
  try {
    source = git(['rev-parse', `${source}^{commit}`]);
    let prior;
    if (previous) {
      previous = git(['rev-parse', `${previous}^{commit}`]);
      prior = read(previous, '.proto-release.json');
      if (read(previous, '.codex-plugin/plugin.json').version !== prior.version) throw new Error('Release metadata mismatch');
      if (prior.sourceCommit === source) return { commit: previous, version: prior.version, reused: true };
      // Reject stale queued runs, divergent history, and hand-edited release branches.
      git(['merge-base', '--is-ancestor', prior.sourceCommit, source]);
    }
    const sourceVersion = read(source, '.codex-plugin/plugin.json').version;
    const floor = [prior?.version, sourceVersion].filter(Boolean).sort().at(-1);
    const version = releaseVersion(floor, now);
    git(['read-tree', source]);
    const put = (path, value) => {
      const blob = git(['hash-object', '-w', '--stdin'], JSON.stringify(value, null, 2) + '\n');
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
    };
    for (const path of ['.codex-plugin/plugin.json', 'plugin.json', '.cursor-plugin/plugin.json']) {
      put(path, { ...read(source, path), version });
    }
    put('.proto-release.json', { sourceCommit: source, version, runId: String(runId) });
    const tree = git(['write-tree']);
    const commit = git(['commit-tree', tree, '-p', source, ...(previous ? ['-p', previous] : [])], `Release ${version}\n\nSource: ${source}\nRun: ${runId}\n`);
    return { commit, version, reused: false };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.env.GITHUB_REPOSITORY !== 'proto-labs-inc/proto-kit' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Releases must run from proto-kit main');
    const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const source = git('rev-parse', 'HEAD');
    if (source !== git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0]) throw new Error('Main advanced; let the newer workflow publish');
    const remote = git('ls-remote', 'origin', 'refs/heads/release').split(/\s/)[0];
    if (remote) git('fetch', 'origin', 'refs/heads/release');
    const result = prepareRelease({ cwd: process.cwd(), source, previous: remote || undefined, runId: process.env.GITHUB_RUN_ID });
    // A normal fast-forward push rejects competing publication; never force push.
    if (!result.reused) git('push', 'origin', `${result.commit}:refs/heads/release`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `commit=${result.commit}\nversion=${result.version}\n`);
    console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
