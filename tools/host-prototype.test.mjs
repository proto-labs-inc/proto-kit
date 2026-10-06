import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hostPrototype } from './host-prototype.mjs';
import { writeJson } from './runner-state.mjs';
function fixture(t) {
  const home=mkdtempSync(join(tmpdir(),'proto-host-'));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const workspace=join(home,'.proto/cb/prototypes/screen');mkdirSync(join(workspace,'public'),{recursive:true});
  writeJson(join(workspace,'public/prototype.json'),{name:'screen',port:4321});
  const calls=[];
  const rpc=async(name,args)=>{calls.push({name,args});if(name==='provision_tunnel')return {connectorToken:'fixture-token',url:'https://fixture.invalid',hostname:'fixture.invalid'};return {};};
  const deps={home,identityOf:async()=>({who:'this'}),tunnelStatus:()=>({status:'connected'}),resolve4:async()=>['127.0.0.1'],execute:async(file,args)=>{calls.push({file,args});return {stdout:JSON.stringify({name:'screen'})};}};
  return {home,workspace,rpc,deps,calls};
}
test('hosting preserves its run, scopes registration to the brief, and verifies through the edge',async t=>{
  const f=fixture(t);const args={workspace:f.workspace,codebase:'cb',briefId:'brief',title:'Screen',rpc:f.rpc,verify:true};
  const first=await hostPrototype(args,f.deps);const spec=join(first.runDir,'spec.json');const before=readFileSync(spec,'utf8');
  assert.equal(statSync(spec).mode & 0o777,0o600);const second=await hostPrototype(args,f.deps);assert.equal(readFileSync(spec,'utf8'),before);
  assert.equal(second.liveUrl,'https://fixture.invalid');assert.equal(f.calls.find(c=>c.name==='register_prototype').args.briefId,'brief');
  assert.ok(f.calls.find(c=>c.file==='curl').args.includes('--resolve'));assert.ok(!JSON.stringify(second).includes('fixture-token'));
});
test('blocked tunnel returns local hosting without an edge probe',async t=>{
  const f=fixture(t);f.deps.tunnelStatus=()=>({status:'blocked'});
  const result=await hostPrototype({workspace:f.workspace,codebase:'cb',briefId:'brief',title:'Screen',rpc:f.rpc,verify:true},f.deps);
  assert.equal(result.tunnel,'blocked');assert.equal(result.liveUrl,null);assert.ok(!f.calls.some(c=>c.file==='curl'));
});
test('an unrelated listener is refused before registration or process startup',async t=>{
  const f=fixture(t);f.deps.identityOf=async()=>({who:'other'});
  await assert.rejects(hostPrototype({workspace:f.workspace,codebase:'cb',briefId:'brief',title:'Screen',rpc:f.rpc},f.deps),/Another workspace/);assert.equal(f.calls.length,0);
});
