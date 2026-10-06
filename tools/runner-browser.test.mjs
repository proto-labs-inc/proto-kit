import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { readJson, writeJson } from './runner-state.mjs';
import { encodePng } from './cdp/png.mjs';
const exec = promisify(execFile);
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const enabled = process.env.PROTO_RUNNER_BROWSER_TEST === '1';
for (const framework of ['react', 'vue']) test(`${framework}: fresh kit snapshot runs real scaffold, render, checks and resumable publication`, { skip: !enabled, timeout: 300000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'proto-runner-browser-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'kit');
  cpSync(kit, installed, { recursive: true, filter: source => !/(^|\/)(node_modules|\.git|\.pnpm-store)(\/|$)/.test(source.slice(kit.length)) });
  const { runBuild } = await import(pathToFileURL(join(installed, 'tools/proto-build.mjs')));
  const home = join(root, 'home'); const source = join(root, 'source'); mkdirSync(source);
  writeJson(join(source, 'package.json'), { dependencies: { [framework]: 'latest' } });
  writeFileSync(join(source, 'Header.tsx'), 'fixture source component');
  const base = join(home, '.proto/cb'); mkdirSync(base, { recursive: true });
  writeJson(join(base, 'codebase.json'), { team: { id: 'team' }, source: { path: source } });
  const brief = { id: 'brief', codebase: 'cb', account_id: 'member', action: 'create-prototype', status: 'awaiting-agent', title: 'Fixture', prototype_slug: null, inputs: { description: 'Change header', useRealData: false, referenceUrl: 'http://127.0.0.1:1/never-visit', referenceImage: '', documentUrl: null, referenceHtml: null } };
  const uploaded = new Map(); let begins = 0; let downloads = 0; let failCompletion = true;
  const pixels = new Uint8Array(80*120*4); for (let i=0;i<pixels.length;i+=4) { pixels[i]=pixels[i+1]=pixels[i+2]=240; pixels[i+3]=255; }
  const png = encodePng({ width: 80, height: 120, data: pixels });
  let origin;
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'PUT') { const chunks=[]; for await (const chunk of req) chunks.push(chunk); uploaded.set(req.url,Buffer.concat(chunks)); res.end('ok'); return; }
      if (req.url === '/reference.png') { downloads++; res.setHeader('Content-Type','image/png'); res.end(png); return; }
      if (req.method === 'GET' && uploaded.has(req.url)) { res.setHeader('Content-Type', req.url.endsWith('.json') ? 'application/json' : 'text/html'); res.end(uploaded.get(req.url)); return; }
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const message=JSON.parse(Buffer.concat(chunks)); let result={};
      if (message.method === 'initialize') result={protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'fixture',version:'1'}};
      else if (message.method === 'tools/call') {
        const { name, arguments: args }=message.params; let value={};
        if (name === 'get_brief') value=brief;
        else if (name === 'begin_build_capture') value={uploadUrl:origin+'/captures/latest.png',url:origin+'/captures/latest.png'};
        else if (name === 'begin_publish') {
          begins++; const buildId='20261005T000000Z-test';
          value={buildId,pathnamePrefix:'build/',expiresAt:new Date(Date.now()+600000).toISOString(),uploads:args.files.map(f=>({...f,url:origin+'/build/'+f.path}))};
        } else if (name === 'finish_publish') value={publishedUrl:origin+'/build/',publishedAt:new Date().toISOString()};
        else if (name !== 'report_build_events' && name !== 'report_progress') throw new Error('Unexpected tool '+name);
        result={content:[{type:'text',text:JSON.stringify(value)}]};
      }
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
    } catch(error) { res.writeHead(500).end(error.message); }
  }).listen(0,'127.0.0.1'); await once(server,'listening'); origin=`http://127.0.0.1:${server.address().port}`;
  t.after(()=>{server.closeAllConnections();server.close();});
  brief.inputs.referenceImage=origin+'/reference.png';
  writeJson(join(home,'.proto/config.json'),{schemaVersion:3,app:origin,credentials:[{secret:'fixture-only',team:{id:'team'},user:{id:'member'},laptop:{id:'laptop'}}]});
  const tools=join(installed,'tools'); const dir=join(base,'run/builds/brief'); const workspace=join(base,'prototypes/fixture');
  const commands=[];
  const deps={home,config:{app:origin},
    async rpc(name,args) {
      if(name==='whoami') return {mode:'laptop-token',team:{id:'team'},user:{id:'member'},capabilities:['prototype-build-claims-v1']};
      if(name==='get_brief') return structuredClone(brief);
      if(name==='begin_prototype_build') { brief.prototype_slug=args.slug;brief.status='building';return structuredClone(brief); }
      if(name==='report_progress') { if(failCompletion) throw new Error('fixture completion outage'); brief.status=args.status;return {}; }
      throw new Error(name);
    },
    async command(file,args,cwd) {
      if(args[0]==='--version' && file==='cloudflared') return 'fixture';
      const result=await exec(file,args,{cwd,env:{...process.env,HOME:home,npm_config_store_dir:process.env.PROTO_TEST_STORE ?? join(tmpdir(),'proto-runner-test-store')},maxBuffer:16*1024*1024,timeout:180000});
      commands.push({file,args,output:result.stdout});return result.stdout;
    },
    async hostPrototype() {return {tunnel:'connected',liveUrl:origin,localUrl:origin};},
    async flushQuestionHistory() {},
  };
  const run=(stage,extra={})=>runBuild({stage,briefId:'brief',codebase:'cb',noSend:true,...extra},deps);
  const first=Date.now();const prepared=await run('prepare');assert.equal(prepared.status,'needs-agent',JSON.stringify(prepared));const coldMs=Date.now()-first;
  const app=framework==='react'?'src/App.tsx':'src/App.vue';
  const body=framework==='react'?`export function App(){return <header data-proto-id="header" style={{height:40}}/>}`:`<template><header data-proto-id="header" style="height:40px" /></template>`;
  writeFileSync(join(workspace,app),body);writeFileSync(join(workspace,'src/styles.css'),'html,body,#root,#app{margin:0;min-height:100%;background:rgb(240,240,240)}');
  writeJson(join(dir,'components.json'),{parts:[{marker:'header',name:'Header',role:'section',sourceFiles:['Header.tsx'],rect:{x:0,y:0,w:80,h:40}}]});
  const before=readFileSync(join(workspace,app),'utf8');const warmStart=Date.now();const warm=await run('prepare');const warmMs=Date.now()-warmStart;
  assert.equal(warm.status,'needs-agent',JSON.stringify(warm));assert.equal(readFileSync(join(workspace,app),'utf8'),before);assert.equal(downloads,1);
  const scaffoldOutputs=commands.filter(c=>c.args[0]?.endsWith('/scaffold.mjs')).map(c=>JSON.parse(c.output));assert.equal(scaffoldOutputs.at(-1).install,0);
  const baseline=await run('check-baseline');assert.equal(baseline.baseline?.status,'passed',JSON.stringify(baseline));
  writeFileSync(join(workspace,app),body.replace('/>', '>Ready</header>'));
  const finish=await run('finish',{changed:'header'});assert.equal(finish.status,'retryable-error',JSON.stringify(finish));
  assert.equal(readJson(join(dir,'publication.json'))?.status,'verified',JSON.stringify(finish));assert.equal(begins,1);
  failCompletion=false;const complete=await run('finish',{changed:'header'});assert.equal(complete.status,'done',JSON.stringify(complete));assert.equal(begins,1);
  assert.equal(commands.filter(c=>c.file==='pnpm' && c.args[0]==='build').length,1);
  t.diagnostic(JSON.stringify({framework,coldPrepareMs:coldMs,warmPrepareMs:warmMs,downloads,publications:begins}));
});
