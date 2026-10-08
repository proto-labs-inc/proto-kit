#!/usr/bin/env node
// Standalone: the update skill downloads this file from GitHub release.
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = 'https://github.com/proto-labs-inc/proto-kit.git';
const shortRepo = 'proto-labs-inc/proto-kit';
const manifest = '.codex-plugin/plugin.json';
const validChannel = channel => typeof channel === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(channel) && !channel.includes('..')
  && channel !== 'release' && !channel.startsWith('preview/') && !channel.endsWith('/') && !channel.endsWith('.lock');
// main's builds are on release; another source branch's on preview/<branch>.
const releaseBranch = channel => channel === 'main' ? 'release' : `preview/${channel}`;
export function updatePlugin(host, { channel = 'main', run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim(), home = homedir(), codexHome = process.env.CODEX_HOME || join(home, '.codex') } = {}) {
  if (!['codex', 'claude', 'cursor'].includes(host)) throw new Error('Pass --agent codex, claude, or cursor.');
  if (!validChannel(channel)) throw new Error('Pass --branch with a proto-kit source branch name.');
  const branch = releaseBranch(channel);
  const scratch = mkdtempSync(join(tmpdir(), 'proto-update-'));
  const json = (cmd, args) => JSON.parse(run(cmd, args));
  const version = root => JSON.parse(readFileSync(join(root, manifest), 'utf8')).version;
  const builtFrom = root => { try { return JSON.parse(readFileSync(join(root, '.proto-release.json'), 'utf8')).channel || 'main'; } catch { return 'main'; } };
  try {
    const checkout = join(scratch, 'release');
    // Verify GitHub before changing any registration. No local/main fallback.
    run('git', ['clone', '--depth', '1', '--single-branch', '--branch', branch, repo, checkout]);
    const expected = version(checkout);
    if (!/^0\.1\.0\+codex\.\d{14}$/.test(expected)) throw new Error('Invalid GitHub release version.');
    let root;
    if (host === 'cursor') {
      root = join(home, '.cursor/plugins/local/proto');
      if (existsSync(root)) {
        if (run('git', ['-C', root, 'status', '--porcelain'])) throw new Error('Cursor plugin has local edits; preserved. Move it aside explicitly before retrying.');
        const origin = run('git', ['-C', root, 'remote', 'get-url', 'origin']);
        if (![repo, repo.replace(/\.git$/, ''), 'git@github.com:proto-labs-inc/proto-kit.git'].includes(origin)) throw new Error('Cursor plugin has a different origin; preserved.');
        // Require current history to be published before switching: no lost local
        // commits. Within one branch that is ancestry; switching between branches,
        // HEAD must be on the release branch it was installed from.
        const from = builtFrom(root);
        if (from !== channel) run('git', ['-C', root, 'fetch', 'origin', releaseBranch(from)]);
        if (from !== channel) run('git', ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
        run('git', ['-C', root, 'fetch', 'origin', branch]);
        if (from === channel) run('git', ['-C', root, 'merge-base', '--is-ancestor', 'HEAD', 'FETCH_HEAD']);
        run('git', ['-C', root, 'checkout', '--detach', 'FETCH_HEAD']);
      } else run('git', ['clone', '--branch', branch, repo, root]);
    } else {
      const listing = json(host, ['plugin', 'marketplace', 'list', '--json']);
      const markets = host === 'codex' ? listing.marketplaces : listing;
      if (!Array.isArray(markets)) throw new Error('Unrecognized marketplace list; nothing changed.');
      const market = markets.find(m => m.name === 'proto-kit');
      // Re-register deterministically: host versions expose source/ref differently.
      // This changes registration only, never the local source checkout.
      if (market) run(host, ['plugin', 'marketplace', 'remove', 'proto-kit']);
      const sourceArgs = host === 'codex' ? [shortRepo, '--ref', branch] : [`${shortRepo}#${branch}`];
      run(host, ['plugin', 'marketplace', 'add', ...sourceArgs]);
      run(host, ['plugin', 'marketplace', host === 'codex' ? 'upgrade' : 'update', 'proto-kit']);
      run(host, ['plugin', host === 'codex' ? 'add' : 'install', 'proto@proto-kit']);
      if (host === 'claude') run(host, ['plugin', 'update', 'proto@proto-kit']);
      const installed = json(host, ['plugin', 'list', '--json', ...(host === 'codex' ? ['-m', 'proto-kit'] : [])]);
      const entries = host === 'codex' ? installed.installed : installed;
      const entry = entries.find(p => (p.pluginId || p.id) === 'proto@proto-kit');
      if (!entry) throw new Error('Proto missing after installation.');
      if (host === 'claude') root = entry.installPath;
      else {
        if (!/^0\.1\.0\+codex\.\d{14}$/.test(entry.version)) throw new Error('Invalid installed version.');
        root = entry.installPath || join(codexHome, 'plugins/cache/proto-kit/proto', entry.version);
      }
    }
    const actual = version(root);
    if (actual !== expected) throw new Error(`Installed ${actual}, expected ${expected}. Release may have advanced; retry.`);
    if (builtFrom(root) !== channel) throw new Error(`Installed a build of ${builtFrom(root)}, expected ${channel}; retry.`);
    if (host === 'codex') run(process.execPath, [join(root, 'tools/codex-install.mjs')]);
    return { status: 'verified', agent: host, branch: channel, version: actual, installedRoot: root, next: `Read the skill needed for the original request from ${root}, then continue that request. Reload the host if its tools or hooks still use the old copy.` };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
// Node resolves the module URL through symlinks, but argv keeps the launch path.
// macOS temporary directories commonly use /var -> /private/var.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  try {
    const args = process.argv.slice(2);
    const usage = 'Usage: node update-plugin.mjs --agent codex|claude|cursor [--branch <proto-kit branch>]';
    if (!(args.length === 2 || args.length === 4) || args[0] !== '--agent' || (args.length === 4 && args[2] !== '--branch')) throw new Error(usage);
    console.log(JSON.stringify(updatePlugin(args[1], { channel: args[3] ?? 'main' }), null, 2));
  } catch (error) { console.error(`Proto update failed: ${error.message}`); process.exitCode = 1; }
}
