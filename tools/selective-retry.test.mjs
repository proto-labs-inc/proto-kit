import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactFiles, retryFingerprint, selectRetryParts } from './selective-retry.mjs';

test('retry queues failures and missing artifacts, preserving matched outputs and outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'proto-selective-'));
  try {
    const parts = ['matched', 'differs', 'failed', 'missing', 'unknown'].map(id => ({id, slug:id, folder:join(root,id), retryFingerprint:retryFingerprint(id)}));
    for (const part of parts) { mkdirSync(part.folder); writeFileSync(join(part.folder,'Part.tsx'), part.id); }
    const saved = { version:1, parts: parts.slice(0,4).map(part => ({ id:part.id, slug:part.slug, retryFingerprint:part.retryFingerprint, reused:null,
      outcome: part.id === 'failed' ? null : {matched:part.id !== 'differs', states:[{result:{verdict:'match'}}]},
      artifacts:part.id === 'missing' ? ['Part.tsx','missing.png'] : artifactFiles(part.folder),
    }))};
    const matchedFile = join(parts[0].folder,'Part.tsx');
    const before = {text:readFileSync(matchedFile,'utf8'),mtime:statSync(matchedFile).mtimeMs};
    const {retained,selected} = selectRetryParts(parts,saved);
    assert.deepEqual(retained.map(p=>p.id),['matched']);
    assert.deepEqual(selected.map(p=>p.id),['differs','failed','missing','unknown']);
    assert.deepEqual(retained[0].outcome,saved.parts[0].outcome);
    const checks=[];
    // Mock the exact retry work queue: retained parts never reach writer/checker.
    for (const part of selected) { writeFileSync(join(part.folder,'Part.tsx'),'rewritten'); checks.push(part.id); }
    assert.equal(checks.includes('matched'),false);
    assert.equal(readFileSync(matchedFile,'utf8'),before.text);
    assert.equal(statSync(matchedFile).mtimeMs,before.mtime);
    assert.equal(parts.filter(p=>p.outcome).includes(retained[0]),true);
    assert.equal(parts.filter(p=>p.outcome?.matched && p.reused===null && !p.retained).includes(retained[0]),false);
    assert.equal(selectRetryParts(parts,null).selected.length,5);
    assert.equal(selectRetryParts([{...parts[0],slug:'changed'}],saved).selected.length,1);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test('artifact manifest includes nested assets', () => {
 const root=mkdtempSync(join(tmpdir(),'proto-selective-'));
 try {mkdirSync(join(root,'assets'));writeFileSync(join(root,'assets','font.woff'),'font');assert.deepEqual(artifactFiles(root),['assets/font.woff']);}
 finally {rmSync(root,{recursive:true,force:true});}
});

 test('changed captures and incompatible checkpoints cannot retain a previous match', () => {
  const part = {id:'a',slug:'a',folder:'/tmp/a',retryFingerprint:retryFingerprint({text:'old',width:100})};
  const saved = {version:1,parts:[{...part,outcome:{matched:true},artifacts:['Part.tsx']}]};
  assert.equal(selectRetryParts([{...part}],saved,()=>true).retained.length,1);
  for (const input of [{text:'new',width:100},{text:'old',width:200}])
    assert.equal(selectRetryParts([{...part,retryFingerprint:retryFingerprint(input)}],saved,()=>true).selected.length,1);
  for (const checkpoint of [null,{}, {version:1,parts:{}}, {version:0,parts:saved.parts}, {version:1,parts:[null]}])
    assert.equal(selectRetryParts([{...part}],checkpoint,()=>true).selected.length,1);
  for (const artifacts of [null,{},[],['../other.tsx'],['/tmp/other.tsx'],[3]])
    assert.equal(selectRetryParts([{...part}],{version:1,parts:[{...saved.parts[0],artifacts}]},()=>true).selected.length,1);
});
