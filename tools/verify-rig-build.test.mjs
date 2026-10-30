import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyRigBuild } from './verify-rig-build.mjs';

/** Real renderer contract, independent of the updater's dependency/build mocks. */
test('compiled-state verification accepts valid bridges and rejects a broken state', { timeout: 90000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'rig-renderer-'));
  const folder = join(root, 'staged/dist'); await mkdir(folder, { recursive: true });
  const manifest = { name: 'checker-fixture', states: [{ id: 'default' }, { id: 'settings' }], variantSets: [] };
  await writeFile(join(folder, 'prototype.json'), JSON.stringify(manifest));
  const html = broken => `<link rel="icon" href="data:,"><h1>Settings</h1><script>
    const state = new URLSearchParams(location.search).get('state');
    parent.postMessage({type:'hello',rigVersion:'0.2.4'},'*');
    parent.postMessage({type:'state-changed',search:location.search},'*');
    ${broken ? "if(state==='settings') console.error('broken settings state');" : ''}
  </script>`;
  try {
    await writeFile(join(folder, 'index.html'), html(false));
    await verifyRigBuild(folder, '0.2.4');
    await writeFile(join(folder, 'index.html'), html(true));
    await assert.rejects(verifyRigBuild(folder, '0.2.4'), /broken settings state/);
    await writeFile(join(folder, 'index.html'), html(false));
    await assert.rejects(verifyRigBuild(folder, '9.9.9'), /rig handshake/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
