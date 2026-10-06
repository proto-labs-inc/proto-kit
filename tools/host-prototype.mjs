#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resolver } from 'node:dns/promises';
import { readJson, writeJson } from './runner-state.mjs';
import { whoAnswers } from './dev-server.mjs';
import { tunnelState } from './tunnel-state.mjs';
import { callTool, readConfig, targetFor } from './mcp-call.mjs';
const exec = promisify(execFile);
const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function hostPrototype({ workspace, codebase, briefId, title, rpc, verify = false }, deps = {}) {
  const execute = deps.execute ?? exec;
  const identityOf = deps.identityOf ?? whoAnswers;
  const tunnelStatus = deps.tunnelStatus ?? tunnelState;
  const invoke = rpc ?? (async (name, args) => {
    const response = await callTool(name, args, targetFor(readConfig(), { codebase }));
    const result = JSON.parse(response.content[0].text);
    if (response.isError) throw new Error(result.message ?? result.error ?? response.content[0].text);
    return result;
  });
  const manifest = readJson(join(workspace, 'public/prototype.json'));
  const { name: slug, port } = manifest;
  const runDir = join(deps.home ?? process.env.HOME, '.proto', codebase, 'run', slug);
  mkdirSync(runDir, { recursive: true });
  const localUrl = `http://localhost:${port}`;
  const before = await identityOf(localUrl, workspace);
  if (before.who === 'other') throw new Error('Another workspace owns the configured preview port.');
  await invoke('register_prototype', { codebase, slug, title, briefId });
  const tunnel = await invoke('provision_tunnel', { kind: 'prototype', codebase, slug, port });
  if (!tunnel.connectorToken || !tunnel.url || !tunnel.hostname) throw new Error('Tunnel provisioning returned an incomplete result.');
  writeJson(join(runDir, 'tunnel.json'), { url: tunnel.url, hostname: tunnel.hostname, port });
  const spec = { name: `${codebase}/${slug}`, processes: [
    { name: 'dev', cwd: workspace, command: ['pnpm', 'dev'], env: { PROTO_TUNNEL: '1', PROTO_PORT: String(port) } },
    { name: 'tunnel', command: ['cloudflared', 'tunnel', 'run', '--token', tunnel.connectorToken] },
    { name: 'heartbeat', command: [process.execPath, join(kit, 'tools/prototype-heartbeat.mjs'), '--kind', 'prototype', runDir, codebase, slug] },
  ] };
  const specPath = join(runDir, 'spec.json');
  const previous = readJson(specPath);
  if (previous && (previous.name !== spec.name || previous.processes?.find(p => p.name === 'dev')?.cwd !== workspace || previous.processes?.find(p => p.name === 'tunnel')?.command?.at(-1) !== tunnel.connectorToken)) {
    // Never silently replace an active run with a changed port, workspace or token.
    throw new Error('The supervised run configuration differs. Inspect the existing run before restarting it.');
  }
  if (!previous) writeJson(specPath, spec);
  await execute(process.execPath, [join(kit, 'tools/supervise.mjs'), 'start', runDir]);
  const until = Date.now() + 30000;
  let identity;
  do { identity = await identityOf(localUrl, workspace); if (identity.who === 'this') break; if (identity.who === 'other') throw new Error('Preview identity changed.'); await sleep(250); } while (Date.now() < until);
  if (identity.who !== 'this') throw new Error('Supervised preview did not become available.');
  let status = tunnelStatus(runDir).status;
  if (verify) {
    const until = Date.now() + 30000;
    while (status === 'connecting' && Date.now() < until) { await sleep(500); status = tunnelStatus(runDir).status; }
  }
  let liveUrl = null;
  if (verify && status === 'connected') {
    const resolver = new Resolver({ timeout: 3000, tries: 1 }); resolver.setServers(['1.1.1.1']);
    const addresses = await (deps.resolve4 ?? (hostname => resolver.resolve4(hostname)))(tunnel.hostname).catch(() => []);
    const deadline = Date.now() + 30000;
    while (addresses.length && Date.now() < deadline) {
      try {
        const { stdout } = await execute('curl', ['-fsS', '--max-time', '3', '--resolve', `${tunnel.hostname}:443:${addresses[0]}`, `${tunnel.url.replace(/\/$/, '')}/prototype.json`]);
        if (JSON.parse(stdout).name === slug) { liveUrl = tunnel.url; break; }
      } catch {}
      await sleep(500);
    }
  }
  return { localUrl, liveUrl, configuredLiveUrl: tunnel.url, tunnel: status, runDir };
}
