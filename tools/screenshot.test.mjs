import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareReference } from './screenshot-reference.mjs';
import { validateComponentMap, compareScreenshot } from './screenshot-check.mjs';
import { encodePng } from './cdp/png.mjs';
import { passGate } from './copy-gate.mjs';

const png = (width = 20, height = 30, color = 240) => encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(color) });
const sourceUrl = 'http://127.0.0.1:1/unreachable/settings';
const imageUrl = 'https://uploads.example/reference.png';
function fixture(t) { const dir = mkdtempSync(join(tmpdir(), 'proto-screenshot-')); t.after(() => rmSync(dir, {recursive: true, force: true})); return dir; }

async function prepare(dir, calls = []) {
  return prepareReference({ runDir: dir, referenceUrl: sourceUrl, referenceImage: imageUrl, fetchImage: async url => {
    calls.push(url); assert.equal(url, imageUrl, 'Never request the source URL');
    return new Response(png(), { headers: {'content-type': 'image/png'} });
  }});
}

test('unreachable source URL, local components and immutable image work without a source-page request', async t => {
  const dir = fixture(t); const calls = []; const reference = await prepare(dir, calls);
  writeFileSync(join(dir, 'Header.tsx'), 'export const Header = () => <header data-proto-id="header">Settings</header>;');
  const map = validateComponentMap({parts: [{marker: 'header', name: 'Settings header', sourceFiles: ['Header.tsx'], rect: {x: 0, y: 0, w: 20, h: 30}}]}, reference, dir);
  writeFileSync(join(dir, 'copy.png'), png());
  const copy = compareScreenshot({runDir: dir, reference, capture: join(dir, 'copy.png'), parts: map.parts, mounted: true, markers: {header: 1}});
  assert.equal(copy.gate.proceed, true);
  assert.equal(copy.parts[0].status, 'matched');
  assert.deepEqual(calls, [imageUrl]);
  const before = readFileSync(join(dir, reference.original));
  const resumed = await prepareReference({runDir: dir, referenceUrl: sourceUrl, referenceImage: imageUrl, fetchImage: () => { throw new Error('Resume must not fetch'); }});
  assert.deepEqual(resumed, reference); assert.deepEqual(readFileSync(join(dir, reference.original)), before);
  writeFileSync(join(dir, 'reference.png'), png(20, 30, 0));
  await assert.rejects(prepare(dir), /comparison image changed/);
});

test('missing/duplicate markers, blank app, changed pixels and truncated dimensions fail the gate', async t => {
  const dir = fixture(t); const reference = await prepare(dir);
  const parts = [{marker: 'header', name: 'Header', rect: {x: 0, y: 0, w: 20, h: 30}}];
  for (const [bytes, mounted, markers] of [[png(), false, {header:1}], [png(), true, {}], [png(), true, {header:2}], [png(20,29), true, {header:1}], [png(20,31), true, {header:1}], [png(20,30,0), true, {header:1}]]) {
    writeFileSync(join(dir, 'copy.png'), bytes);
    const copy = compareScreenshot({ runDir: dir, reference, capture: join(dir, 'copy.png'), parts, mounted, markers });
    assert.equal(copy.gate.proceed, false);
  }
});

test('source mapping requires real files and stable unique markers', async t => {
  const dir = fixture(t); const reference = await prepare(dir);
  const part = {marker: 'header', name: 'Header', sourceFiles: ['missing.tsx'], rect: {x:0,y:0,w:20,h:30}};
  assert.throws(() => validateComponentMap({parts:[part]},reference,dir), /Missing source/);
  writeFileSync(join(dir,'Header.tsx'),'source'); part.sourceFiles=['Header.tsx'];
  assert.throws(() => validateComponentMap({parts:[{...part,role:'unknown'}]},reference,dir), /section or a leaf/);
  assert.equal(validateComponentMap({parts:[{...part,role:'section'}]},reference,dir).parts[0].role, 'section');
  assert.throws(() => validateComponentMap({parts:[part,part]},reference,dir), /unique stable/);
  assert.throws(() => validateComponentMap({parts:[{...part,rect:{x:0,y:0,w:21,h:30}}]},reference,dir), /Invalid screenshot region/);
});

test('failed screenshot gate waits for an explicit answer and resumes the same checkpoint', async t => {
  const dir = fixture(t); const reference = await prepare(dir);
  const parts = [{marker:'header', name:'Header', rect:{x:0,y:0,w:20,h:30}}];
  writeFileSync(join(dir,'copy.png'),png(20,30,0));
  const replicated = compareScreenshot({runDir:dir,reference,capture:join(dir,'copy.png'),parts,mounted:true,markers:{header:1}});
  let checkpoint; let checks=0; let questions=0;
  const deps = {replicated, tree:{regions:parts}, copy:async()=>{checks++; return replicated;}, settle:async()=>{}, ask:async()=>{questions++;return 'q-1';}, wait:async()=>({status:'needs-input'}), save:value=>{checkpoint=value;}};
  assert.equal((await passGate(deps)).outcome,'needs-input'); assert.equal(checks,1); assert.equal(questions,1);
  assert.equal((await passGate({...deps,checkpoint})).outcome,'needs-input'); assert.equal(checks,1); assert.equal(questions,1);
  const accepted = await passGate({...deps, checkpoint, wait:async()=>({by:'option',option:'build'})});
  assert.equal(accepted.outcome,'build'); assert.equal(checks,1);
});

test('unreadable screenshot blocks instead of fetching the source URL', async t => {
  const dir=fixture(t); const calls=[];
  await assert.rejects(prepareReference({runDir:dir, referenceUrl:sourceUrl,referenceImage:imageUrl,fetchImage:async url=>{calls.push(url);return new Response('missing',{status:404});}}), /could not be downloaded/);
  assert.deepEqual(calls,[imageUrl]);
});
