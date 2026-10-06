import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodePng } from './cdp/png.mjs';
import { prepareReference } from './screenshot-reference.mjs';
import { validateComponentMap, checkScreenshot } from './screenshot-check.mjs';

test('local source component renders against uploaded screenshot with an unreachable source URL', {skip:process.env.PROTO_SCREENSHOT_BROWSER_TEST !== '1'}, async t => {
  const dir=mkdtempSync(join(tmpdir(),'proto-screenshot-browser-')); t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const source=join(dir,'source');const workspace=join(dir,'workspace'); const runDir=join(dir,'build');
  mkdirSync(source);mkdirSync(join(workspace,'public'),{recursive:true});
  // The fixture's source component is copied into the standalone prototype.
  writeFileSync(join(source,'Header.html'),'<header data-proto-id="header" style="height:40px;background:rgb(240,240,240)"></header>');
  const html=`<!doctype html><style>body{margin:0;background:rgb(240,240,240)}</style><div id="root">${readFileSync(join(source,'Header.html'),'utf8')}</div>`;
  writeFileSync(join(workspace,'index.html'),html);
  const data=new Uint8Array(80*120*4);for(let i=0;i<data.length;i+=4){data[i]=data[i+1]=data[i+2]=240;data[i+3]=255;}
  const screenshot=encodePng({width:80,height:120,data});
  const paths=[];
  const server=createServer((req,res)=>{
    paths.push(req.url);
    if(req.url==='/reference.png'){res.setHeader('content-type','image/png');res.end(screenshot);return;}
    if(req.url==='/prototype.json'){res.setHeader('content-type','application/json');res.end(readFileSync(join(workspace,'public','prototype.json')));return;}
    if(req.url==='/__proto-workspace.json'){res.setHeader('content-type','application/json');res.end('{"token":"screenshot-fixture"}');return;}
    res.setHeader('content-type','text/html');res.end(readFileSync(join(workspace,'index.html')));
  }).listen(0,'127.0.0.1'); await once(server,'listening'); t.after(()=>{server.closeAllConnections();server.close();});
  const port=server.address().port;
  writeFileSync(join(workspace,'public','prototype.json'),JSON.stringify({name:'fixture',port}));
  writeFileSync(join(workspace,'public','__proto-workspace.json'),'{"token":"screenshot-fixture"}');
  const ref=await prepareReference({runDir,referenceUrl:'http://127.0.0.1:1/unreachable/settings',referenceImage:`http://127.0.0.1:${port}/reference.png`});
  const map=validateComponentMap({parts:[{marker:'header',name:'Header',sourceFiles:['Header.html'],rect:{x:0,y:0,w:80,h:40}}]},ref,source);
  const result=await checkScreenshot({runDir,reference:ref,workspace,parts:map.parts});
  assert.equal(result.gate.proceed,true,result.gate.line);
  assert.equal(result.parts[0].status,'matched');
  assert.equal(paths.filter(path=>path==='/reference.png').length,1);
  const resumed=await prepareReference({runDir,referenceUrl:ref.url,referenceImage:ref.image,fetchImage:()=>{throw new Error('Resume must use original bytes');}});
  assert.equal(resumed.sha256,ref.sha256);
  writeFileSync(join(workspace,'index.html'),html.replaceAll('240,240,240','0,0,0'));
  const changed=await checkScreenshot({runDir,reference:ref,workspace,parts:map.parts});
  assert.equal(changed.gate.proceed,false);
});
