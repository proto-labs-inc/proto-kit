import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { runBuild } from './proto-build.mjs';
import { fingerprint, readJson, writeJson, lockBuild } from './runner-state.mjs';
import { answeredInTerminal } from './ask.mjs';
function fixture(t, framework = 'react') {
  const home = mkdtempSync(join(tmpdir(), 'proto-runner-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const source = join(home, 'source'); mkdirSync(source); writeFileSync(join(source, 'Header.tsx'), 'header');
  const base = join(home, '.proto/cb'); mkdirSync(base, { recursive: true });
  writeJson(join(base, 'codebase.json'), { team: { id: 'team' }, source: { path: source } });
  const dir = join(base, 'run/builds/brief');
  const brief = { id: 'brief', codebase: 'cb', account_id: 'member', action: 'create-prototype', status: 'awaiting-agent', title: 'Usage', prototype_slug: null, inputs: { description: 'Add map', useRealData: false, referenceUrl: 'https://source.invalid/route', referenceImage: 'https://image.invalid/ref.png', documentUrl: null, referenceHtml: null } };
  const counts = { claims: 0, downloads: 0, installs: 0, captures: 0, builds: 0, publishes: 0, checks: 0 };
  let passes = true; let reportFailure = false; let stateFailure = false;
  const part = { marker: 'header', id: 'header', name: 'Header', role: 'section', sourceFiles: ['Header.tsx'], rect: { x: 0, y: 0, w: 10, h: 10 } };
  const events = [];
  const deps = {
    home, config: { app: 'http://app.invalid' },
    reporter: { send(batch) { events.push(...batch); }, async flush() {}, async upload() { return 'https://image.invalid/upload.png'; } },
    async rpc(name, args) {
      if (name === 'whoami') return { mode: 'laptop-token', user: { id: 'member' }, team: { id: 'team' }, capabilities: ['prototype-build-claims-v1'] };
      if (name === 'get_brief') return structuredClone(brief);
      if (name === 'begin_prototype_build') { counts.claims++; brief.prototype_slug = args.slug; brief.status = 'building'; return structuredClone(brief); }
      if (name === 'report_progress') { if (reportFailure) throw new Error('report offline'); if (args.status === 'done') brief.status = 'done'; return {}; }
      throw new Error(name);
    },
    async prepareReference({ referenceUrl, referenceImage }) {
      const path = join(dir, 'reference.json'); if (existsSync(path)) return readJson(path);
      counts.downloads++; writeFileSync(join(dir, 'reference.png'), 'immutable');
      const ref = { url: referenceUrl, image: referenceImage, sha256: 'sha', width: 10, height: 10 }; writeJson(path, ref); return ref;
    },
    async checkScreenshot() { counts.captures++; return { parts: [{ ...part, status: passes ? 'matched' : 'differs', mismatch: passes ? 0 : 50 }], gate: { proceed: passes, line: 'Screenshot difference: 50%' } }; },
    async hostPrototype() { return { tunnel: 'connected', localUrl: 'http://localhost:1234', liveUrl: 'https://live.invalid' }; },
    async flushQuestionHistory() {},
    async command(file, args, cwd) {
      if (args[0] === '--version') return '1';
      if (file === 'pnpm') {
        if (args[0] === 'build') { counts.builds++; mkdirSync(join(cwd, 'dist'), { recursive: true }); writeFileSync(join(cwd, 'dist/index.html'), readFileSync(join(cwd, 'src/App.txt'))); }
        return '';
      }
      const tool = basename(args[0]); const workspace = join(base, 'prototypes', brief.prototype_slug);
      if (tool === 'scaffold.mjs') {
        if (!existsSync(workspace)) {
          counts.installs++; mkdirSync(join(workspace, 'public'), { recursive: true }); mkdirSync(join(workspace, 'src'));
          writeJson(join(workspace, 'public/prototype.json'), { name: brief.prototype_slug, port: 1234, framework });
          writeFileSync(join(workspace, 'src/App.txt'), framework); writeJson(join(dir, 'components.json'), { parts: [part] });
        }
        writeJson(join(dir, 'workspace.json'), { slug: brief.prototype_slug, path: workspace, framework, port: 1234 }); return '';
      }
      if (tool === 'check-states.mjs') { counts.checks++; return JSON.stringify({ ok: !stateFailure, problems: stateFailure ? 1 : 0 }); }
      if (tool === 'previews.mjs') return JSON.stringify({ missing: [] });
      if (tool === 'publish.mjs') {
        const outputHash = fingerprint(join(workspace, 'dist'), { output: true });
        if (readJson(join(dir, 'publication.json'))?.outputHash !== outputHash) counts.publishes++;
        writeJson(join(dir, 'publication.json'), { status: 'verified', outputHash, publishedUrl: 'https://published.invalid/build/' }); return '';
      }
      if (tool === 'verify-markers.mjs') return '';
      throw new Error(tool);
    },
  };
  const run = (stage, extra = {}) => runBuild({ stage, briefId: 'brief', codebase: 'cb', noSend: true, ...extra }, deps);
  const edit = text => writeFileSync(join(base, 'prototypes', brief.prototype_slug, 'src/App.txt'), text);
  return { home, base, dir, brief, deps, events, counts, run, edit, setPass: value => passes = value, setReportFailure: value => reportFailure = value, setStateFailure: value => stateFailure = value };
}
for (const framework of ['react', 'vue']) test(`${framework}: warm preparation and completion retry do not repeat work`, async t => {
  const f = fixture(t, framework);
  assert.equal((await f.run('prepare')).status, 'needs-agent'); f.edit('baseline');
  assert.equal((await f.run('prepare')).status, 'needs-agent');
  assert.equal(f.counts.claims, 1); assert.equal(f.counts.downloads, 1); assert.equal(f.counts.installs, 1);
  await f.run('check-baseline'); await f.run('check-baseline'); assert.equal(f.counts.captures, 1);
  f.edit('feature'); f.setReportFailure(true);
  assert.equal((await f.run('finish', { changed: 'header' })).status, 'retryable-error');
  f.setReportFailure(false); assert.equal((await f.run('finish', { changed: 'header' })).status, 'done');
  assert.equal(f.counts.builds, 1); assert.equal(f.counts.publishes, 1); assert.equal(f.counts.checks, 1);
  const before = readFileSync(join(f.dir, 'runner.json'), 'utf8'); await f.run('prepare');
  assert.equal(readFileSync(join(f.dir, 'runner.json'), 'utf8'), before, 'completed requests remain untouched');
});
test('failed checks block publication and edited inputs invalidate verification', async t => {
  const f = fixture(t); await f.run('prepare'); await f.run('check-baseline'); f.edit('change'); f.setStateFailure(true);
  assert.equal((await f.run('finish', { changed: 'header' })).status, 'needs-agent'); assert.equal(f.counts.publishes, 0);
  f.setStateFailure(false); f.setReportFailure(true); await f.run('finish', { changed: 'header' }); f.edit('second change'); await f.run('finish', { changed: 'header' });
  assert.equal(f.counts.builds, 2); assert.equal(f.counts.publishes, 2);
});
test('two changed repair rounds precede a stable question; acceptance belongs to that baseline', async t => {
  const f = fixture(t); await f.run('prepare'); f.setPass(false);
  assert.equal((await f.run('check-baseline')).repairsRemaining, 2);
  await f.run('check-baseline'); assert.equal(f.counts.captures, 1);
  f.edit('repair1'); assert.equal((await f.run('check-baseline')).repairsRemaining, 1);
  f.edit('repair2'); const question = await f.run('check-baseline'); assert.equal(question.status, 'needs-input');
  assert.equal((await f.run('check-baseline')).questionId, question.questionId);
  await answeredInTerminal({ runDir: f.dir, briefId: 'brief', codebase: 'cb', sink: 'file' }, question.questionId, { option: 'build' });
  const accepted = await f.run('check-baseline'); assert.equal(accepted.baseline.status, 'accepted'); assert.equal(f.counts.captures, 3);
  f.edit('different baseline'); const next = await f.run('check-baseline'); assert.equal(next.status, 'needs-input'); assert.notEqual(next.questionId, question.questionId);
});
test('rendering errors never produce a visual gate', async t => {
  const f = fixture(t); await f.run('prepare'); f.deps.checkScreenshot = async () => { const error = new Error('missing export'); error.name = 'RenderError'; throw error; };
  assert.equal((await f.run('check-baseline')).status, 'needs-agent'); assert.equal(readJson(join(f.dir, 'runner.json')).baseline, undefined);
});
test('unrelated local slugs are skipped without changing them', async t => {
  const f = fixture(t); mkdirSync(join(f.base, 'prototypes/usage'), { recursive: true });
  await f.run('prepare'); assert.equal(f.brief.prototype_slug, 'usage-2');
});
test('lock excludes a concurrent runner and fingerprints see uncommitted changes', t => {
  const f = fixture(t); const release = lockBuild(f.dir); assert.throws(() => lockBuild(f.dir), /active runner/); release();
  const source = join(f.home, 'source'); const before = fingerprint(source); writeFileSync(join(source, 'Header.tsx'), 'edited'); assert.notEqual(fingerprint(source), before);
  mkdirSync(join(source, 'dist')); writeFileSync(join(source, 'dist/generated'), 'ignored'); const content = fingerprint(source); writeFileSync(join(source, 'dist/generated'), 'changed'); assert.equal(fingerprint(source), content);
});

test('missing references block preparation before a claim or scaffold', async t => {
  const f = fixture(t); f.brief.inputs.referenceImage = null;
  const result = await f.run('prepare');
  assert.equal(result.status, 'needs-input'); assert.equal(f.counts.claims, 0); assert.equal(f.counts.installs, 0);
});

test('baseline report failure resumes evidence without recapturing and preserves report identities', async t => {
  const f = fixture(t); await f.run('prepare'); const sent=[]; let flushes=0;
  f.deps.reporter.send=events=>sent.push(...events);
  f.deps.reporter.flush=async()=>{ if (++flushes===2) throw new Error('fixture report failure'); };
  assert.equal((await f.run('check-baseline')).status,'retryable-error');
  const first=sent.filter(event=>event.kind==='pass');
  assert.equal((await f.run('check-baseline')).baseline.status,'passed');
  const passes=sent.filter(event=>event.kind==='pass');assert.equal(f.counts.captures,1);
  assert.equal(passes.length,2);assert.deepEqual(passes[1],first[0]);
  assert.ok(sent.some(event=>event.kind==='matched'));
  assert.ok(sent.some(event=>event.kind==='workflow' && event.step==='build'));
});


test('successful stages report the next work and preparation retries preserve it', async t => {
  const f = fixture(t);
  await f.run('prepare');
  assert.equal(readJson(join(f.dir, 'workflow.json')).step, 'copy');
  assert.ok(f.events.some(e => e.kind === 'workflow' && e.step === 'connect' && e.status === 'completed'));
  await f.run('check-baseline');
  assert.equal(readJson(join(f.dir, 'workflow.json')).step, 'build');
  f.events.length = 0;
  await f.run('prepare');
  assert.equal(readJson(join(f.dir, 'workflow.json')).step, 'build');
  assert.ok(!f.events.some(e => e.kind === 'workflow' && ['connect', 'copy'].includes(e.step)));
  f.edit('feature');
  assert.equal((await f.run('finish', { changed: 'header' })).status, 'done');
  const steps = f.events.filter(e => e.kind === 'workflow');
  assert.ok(steps.some(e => e.step === 'check' && e.status === 'completed'));
  assert.ok(steps.some(e => e.step === 'publish' && e.status === 'active'));
  assert.equal(steps.at(-1).step, 'publish');
  assert.equal(steps.at(-1).status, 'completed');
});

test('missing title does not report preparation success', async t => {
  const f = fixture(t); f.brief.title = 'Untitled';
  assert.equal((await f.run('prepare')).status, 'needs-agent');
  assert.equal(f.counts.installs, 0);
  assert.ok(!f.events.some(e => e.kind === 'workflow' && (e.status === 'completed' || e.step === 'copy')));
});

test('failed progress delivery blocks success and preparation retries reuse work', async t => {
  const f = fixture(t); let flushes = 0;
  f.deps.reporter.flush = async () => { if (++flushes === 2) throw new Error('progress offline'); };
  assert.equal((await f.run('prepare')).status, 'retryable-error');
  assert.equal((await f.run('prepare')).status, 'needs-agent');
  assert.equal(f.counts.installs, 1); assert.equal(f.counts.claims, 1);
  assert.equal(readJson(join(f.dir, 'workflow.json')).step, 'copy');
});

test('initial reporting failure stops work instead of being swallowed', async t => {
  const f = fixture(t);
  f.deps.reporter.flush = async () => { throw new Error('progress offline'); };
  assert.equal((await f.run('prepare')).status, 'retryable-error');
  assert.equal(f.counts.claims, 0);
});
