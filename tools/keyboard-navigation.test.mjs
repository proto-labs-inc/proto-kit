import test from 'node:test';import assert from 'node:assert/strict';import{mkdtempSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{serveBuild,runScenario}from'./verify-screen.mjs';
test('keyboard targets use real Tab navigation and reject unreachable controls',{skip:process.env.PROTO_BROWSER_TEST!=='1'},async t=>{
 const dir=mkdtempSync(join(tmpdir(),'proto-keyboard-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));writeFileSync(join(dir,'index.html'),`<button>First</button><button id="target" onclick="document.querySelector('output').textContent='Activated'">Target</button><button id="disabled" disabled>Disabled</button><output></output><script>parent.postMessage({type:'hello'},'*')</script>`);const server=await serveBuild(dir);t.after(()=>server.close());
 const scenario={id:'keyboard',category:'keyboard',path:'/',steps:[{kind:'key',key:'Tab',until:'#target'},{kind:'key',key:'Enter'}],assertion:'document.querySelector("output").textContent==="Activated"'};
 assert.deepEqual(await runScenario(server.url,scenario,join(dir,'pass.png'),{width:320,height:900}),[]);
 const failed=await runScenario(server.url,{...scenario,steps:[{kind:'key',key:'Tab',until:'#disabled'}]},join(dir,'fail.png'),{width:320,height:900});assert.ok(failed.some(p=>p.includes('not reachable by keyboard')));
});
