import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maintainRig, sourceFingerprint, saveJournal } from './rig-maintenance.mjs';

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'rig-transaction-'));
  const previous = process.env.PROTO_HOME; process.env.PROTO_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.PROTO_HOME; else process.env.PROTO_HOME = previous; await rm(home, { recursive: true, force: true }); });
  const workspace = join(home, 'code/prototypes/sample'), root = join(home, 'maintenance'), file = join(root, 'job.json');
  await mkdir(workspace, { recursive: true }); await mkdir(root);
  await writeFile(join(workspace, 'package.json'), JSON.stringify({ dependencies: { '@proto-labs-inc/rig': '0.1.0' } }));
  await writeFile(join(workspace, 'app.txt'), 'original app');
  saveJournal(file, { codebase: 'code', slug: 'sample', targetVersion: '0.2.4', expectedPublishedUrl: null, stage: 'queued' });
  let builds = 0, uploads = 0, finishes = 0;
  const options = {
    builtVersion: () => "0.2.4",
    runCommand: async args => {
      if (args[0].endsWith('update-rig.mjs')) {
        builds++;
        await writeFile(join(args[1], 'package.json'), JSON.stringify({ dependencies: { '@proto-labs-inc/rig': '0.2.4' } }));
      } else {
        uploads++;
        await writeFile(join(root, 'publish.json'), JSON.stringify({ kind: 'prototype', codebase: 'code', slug: 'sample', buildId: 'immutable', expectedPublishedUrl: null }));
      }
    },
    verifyBuild: async () => {},
    finish: async input => { finishes++; assert.equal(input.buildId, 'immutable'); return { publishedUrl: 'https://builds.invalid/immutable/' }; },
  };
  return { home, root, file, workspace, options, counts: () => ({ builds, uploads, finishes }) };
}

test('a failed verification never installs the staged files or publishes them', async t => {
  const f = await fixture(t), before = await sourceFingerprint(f.workspace);
  f.options.verifyBuild = async () => { throw new Error('checkout state has a runtime exception'); };
  await assert.rejects(maintainRig(f.file, f.options), /runtime exception/);
  assert.equal(await sourceFingerprint(f.workspace), before);
  assert.equal(f.counts().uploads, 0);
  assert.equal(existsSync(join(f.root, 'backup')), false);
});

test('an external edit during preparation is preserved and prevents application', async t => {
  const f = await fixture(t);
  f.options.verifyBuild = async () => writeFile(join(f.workspace, 'app.txt'), 'new user edit');
  await assert.rejects(maintainRig(f.file, f.options), /Workspace changed during preparation/);
  assert.equal(await readFile(join(f.workspace, 'app.txt'), 'utf8'), 'new user edit');
  assert.equal(f.counts().uploads, 0);
});

test('response-loss recovery retries the same immutable publication without rebuilding or uploading', async t => {
  const f = await fixture(t), finish = f.options.finish;
  f.options.finish = async () => { throw new Error('fetch failed'); };
  await assert.rejects(maintainRig(f.file, f.options), /fetch failed/);
  const afterFailure = f.counts();
  assert.equal(JSON.parse(await readFile(f.file)).stage, 'publishing');
  f.options.finish = finish;
  const result = await maintainRig(f.file, f.options);
  assert.equal(result.stage, 'complete');
  assert.equal(f.counts().builds, afterFailure.builds);
  assert.equal(f.counts().uploads, afterFailure.uploads);
  assert.equal(existsSync(join(f.root, 'backup')), false);
});

test('recovery never overwrites a local edit made after the verified installation', async t => {
  const f = await fixture(t);
  f.options.finish = async () => { throw new Error('fetch failed'); };
  await assert.rejects(maintainRig(f.file, f.options));
  await writeFile(join(f.workspace, 'app.txt'), 'later edit');
  await assert.rejects(maintainRig(f.file, f.options), /Workspace changed after preparation/);
  assert.equal(await readFile(join(f.workspace, 'app.txt'), 'utf8'), 'later edit');
});

test('a crash between workspace renames restores the original before finishing the verified swap', async t => {
  const f = await fixture(t);
  const staged = join(f.root, 'staged'); await mkdir(staged);
  await writeFile(join(staged, 'app.txt'), 'original app');
  await writeFile(join(staged, 'package.json'), JSON.stringify({ dependencies: { '@proto-labs-inc/rig': '0.2.4' } }));
  const job = JSON.parse(await readFile(f.file));
  Object.assign(job, { stage: 'applying', sourceFingerprint: await sourceFingerprint(f.workspace), preparedFingerprint: await sourceFingerprint(staged) });
  saveJournal(f.file, job); await rename(f.workspace, join(f.root, 'backup'));
  const result = await maintainRig(f.file, f.options);
  assert.equal(result.stage, 'complete');
  assert.equal(f.counts().builds, 0);
  assert.equal(await readFile(join(f.workspace, 'app.txt'), 'utf8'), 'original app');
});

test('a confirmed publisher result is consumed without calling finish a second time', async t => {
  const f = await fixture(t), run = f.options.runCommand;
  f.options.runCommand = async args => {
    await run(args);
    if (args[0].endsWith('publish.mjs')) saveJournal(join(f.root, 'publish-result.json'), { publishedUrl: 'https://builds.invalid/confirmed/' });
  };
  f.options.finish = async () => assert.fail('An already confirmed publication must not finish again');
  const result = await maintainRig(f.file, f.options);
  assert.equal(result.stage, 'complete');
  assert.equal(result.publishedUrl, 'https://builds.invalid/confirmed/');
});

test('completed recovery removes its old backup without rebuilding or publishing', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'backup'));
  await writeFile(join(f.root, 'backup/app.txt'), 'old version');
  saveJournal(f.file, { ...JSON.parse(await readFile(f.file)), stage: 'complete', publishedUrl: 'https://builds.invalid/confirmed/' });
  await maintainRig(f.file, f.options);
  assert.equal(existsSync(join(f.root, 'backup')), false);
  assert.deepEqual(f.counts(), { builds: 0, uploads: 0, finishes: 0 });
});
