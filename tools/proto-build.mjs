#!/usr/bin/env node
/** Resumable screenshot-first creation. Source URLs are metadata, never browser targets. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextPassFor } from './build-folder.mjs';
import { readBriefInputs } from './brief-inputs.mjs';
import { prepareReference } from './screenshot-reference.mjs';
import { validateComponentMap, checkScreenshot } from './screenshot-check.mjs';
import { createReporter } from './build-report.mjs';
import { workflowEvent } from './workflow-report.mjs';
import { TAIL } from './tail.mjs';
import { callTool, readConfig, targetFor } from './mcp-call.mjs';
import { ask, waitForAnswer, flushQuestionHistory } from './ask.mjs';
import { hostPrototype } from './host-prototype.mjs';
import { checkpoint, fingerprint, hash, lockBuild, readJson, writeJson } from './runner-state.mjs';
import { TUNNEL_BLOCKED_SENTENCE } from './tunnel-state.mjs';
const exec = promisify(execFile);
const tools = dirname(fileURLToPath(import.meta.url));
const STAGES = ['prepare', 'check-baseline', 'finish'];
export const preferredSlug = title => title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55).replace(/-$/, '') || 'prototype';
function need(message, status = 'needs-input') { const error = new Error(message); error.status = status; throw error; }
function unwrap(response) {
  let value; try { value = JSON.parse(response.content[0].text); } catch { value = { message: response.content?.[0]?.text }; }
  if (response.isError) { const error = new Error(value.message ?? value.error ?? 'Proto request failed'); error.code = value.code; throw error; }
  return value;
}
export async function runBuild(options, deps = {}) {
  try { return await executeBuild(options, deps); }
  catch (error) {
    const setup = /credential|not set up|setup skill|401/.test(error.message);
    return { status: setup ? 'needs-input' : 'retryable-error', stage: options.stage, briefId: options.briefId,
      diagnostics: [error.message], next: setup ? 'Reconnect this existing codebase through setup, then rerun the same command.' : 'Resolve the reported issue and retry the same stage.' };
  }
}
async function executeBuild({ stage, briefId, codebase, title, changed = '', noSend = false }, deps = {}) {
  if (!STAGES.includes(stage) || ![briefId, codebase].every(id => /^[a-zA-Z0-9_-]+$/.test(id ?? ''))) throw new Error('Use prepare, check-baseline, or finish with briefId and --codebase.');
  const stageStarted = Date.now(); const preflightTimings = [];
  const home = deps.home ?? process.env.HOME;
  const runDir = join(home, '.proto', codebase, 'run/builds', briefId);
  const at = name => join(runDir, name);
  const record = readJson(join(home, '.proto', codebase, 'codebase.json'));
  if (!record?.team?.id) return { status: 'needs-input', stage, briefId, next: 'Run setup to restore this existing codebase source record.' };
  const config = deps.config ?? readConfig();
  const target = deps.rpc ? null : targetFor(config, { codebase });
  const rawRpc = deps.rpc ?? (async (name, args) => unwrap(await callTool(name, args, target, { signal: AbortSignal.timeout(30000) })));
  const preflight = async (name, args) => { const start = Date.now(); try { return await rawRpc(name, args); } finally { preflightTimings.push({ kind: 'network', name, ms: Date.now() - start }); } };
  const identity = await preflight('whoami', {});
  if (identity.mode !== 'laptop-token' || identity.team?.id !== record.team?.id) return { status: 'needs-input', stage, briefId, next: 'Use setup to link this laptop to the codebase team.' };
  const response = await preflight('get_brief', { briefId }); const brief = response.brief ?? response;
  if (brief.codebase !== codebase || brief.account_id !== identity.user?.id || brief.action !== 'create-prototype') return { status: 'needs-input', stage, briefId, next: 'The saved request identity, codebase or action does not match.' };
  if (brief.status === 'done') return { status: 'done', stage, briefId, slug: brief.prototype_slug, urls: readJson(at('runner.json'))?.stages?.finish?.urls, next: 'This request is already complete.' };
  if (!record.source?.path || !existsSync(record.source.path)) return { status: 'needs-input', stage, briefId, next: 'Run setup to restore this existing codebase source record.' };
  if (!identity.capabilities?.includes('prototype-build-claims-v1')) return { status: 'needs-input', stage, briefId, next: 'Update the Proto app to support atomic prototype build claims before running this kit.' };
  const release = lockBuild(runDir); let run;
  try {
    run = checkpoint(runDir, { briefId, codebase }); const { state, save, measure } = run;
    state.timings.push(...preflightTimings);
    const build = { codebase, briefId, runDir, sink: noSend ? 'file' : 'site', progressTarget: target };
    const reporter = deps.reporter ?? createReporter({ ...build, transport: (name, args) => callTool(name, args, target, { signal: AbortSignal.timeout(30000) }) });
    const rpc = (name, args) => measure('network', name, () => rawRpc(name, args));
    const command = (file, args = [], cwd) => measure('subprocess', file, async () => {
      if (deps.command) return deps.command(file, args, cwd);
      try {
        const result = await exec(file, args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 300000 });
        if (result.stderr) console.error(result.stderr.trim()); return result.stdout;
      } catch (error) { if ((file === 'pnpm' && ['typecheck', 'build'].includes(args[0])) || ['verify-markers.mjs', 'check-states.mjs', 'previews.mjs'].some(name => args[0]?.endsWith('/' + name))) error.status = 'needs-agent'; throw error; }
    });
    const tool = (name, args) => command(process.execPath, [join(tools, name), ...args]);
    const done = result => {
      if (['needs-agent', 'needs-input'].includes(result.status)) state.waiting = { kind: result.status === 'needs-agent' ? 'awaiting-agent' : 'awaiting-user', stage, since: Date.now() };
      save(); return { stage, briefId, codebase, artifacts: { runDir, workspace: state.workspace?.path }, ...result };
    };
    let step = 'check';
    if (stage === 'prepare') step = 'connect';
    else if (stage === 'check-baseline') step = 'copy';
    // Preparation retries must not reset agent work already in progress.
    const previousWorkflow = readJson(at('workflow.json'));
    const resumePreparation = stage === 'prepare' && state.stages.prepare && previousWorkflow;
    const workflow = resumePreparation || workflowEvent(runDir, step, `Running ${stage}`);
    reporter.send([workflow]);
    await reporter.flush();
    let inputs;
    try { inputs = readBriefInputs(brief); } catch (error) { need(error.message); }
    if (!inputs.referenceUrl || !inputs.referenceImage) need('This unfinished request needs both referenceUrl and referenceImage in brief.inputs.');
    if (state.slug && state.slug !== brief.prototype_slug) need('Cloud target and runner checkpoint disagree. Preserve both and resolve the target.');
    if (stage === 'prepare') {
      if (Number(process.versions.node.split('.')[0]) < 20) need('Proto requires Node 20 or newer.');
      for (const binary of ['pnpm', 'cloudflared']) await command(binary, ['--version']);
      for (const file of ['brief-inputs.mjs', 'screenshot-reference.mjs', 'screenshot-check.mjs']) if (!existsSync(join(tools, file))) need(`The kit is incomplete: ${file}. Update the whole plugin.`);
      const saved = readJson(at('workspace.json'));
      const slug = state.slug ?? brief.prototype_slug ?? saved?.slug;
      const buildTitle = state.title ?? title ?? brief.title;
      if (!buildTitle?.trim() || (!title && !state.title && /^(new prototype|untitled|prototype)$/i.test(buildTitle.trim()))) return done({ status: 'needs-agent', inputs, next: 'Choose a meaningful 2 to 5 word title from the brief, then rerun prepare with --title.' });
      const base = preferredSlug(buildTitle);
      for (let suffix = 1; !state.stages.claim; suffix++) {
        if (suffix > 1000) need('Unable to find an unused prototype slug.');
        let candidate = slug;
        if (!candidate) candidate = suffix === 1 ? base : `${base}-${suffix}`;
        const workspacePath = join(home, '.proto', codebase, 'prototypes', candidate);
        if (existsSync(workspacePath) && saved?.path !== workspacePath) {
          if (slug) need('The claimed slug has an unrelated local workspace. Preserve it and resolve the conflict.');
          continue;
        }
        try {
          const claim = await rpc('begin_prototype_build', { codebase, briefId, slug: candidate, title: buildTitle });
          if (claim.id !== briefId || claim.prototype_slug !== candidate) need('The server returned an unexpected build claim.');
          state.slug = candidate; state.title = buildTitle; state.stages.claim = { slug: candidate }; save();
        } catch (error) { if (!slug && error.code === 'slug-conflict') continue; throw error; }
      }
      const reference = await measure('local', 'reference', () => (deps.prepareReference ?? prepareReference)({ runDir, referenceUrl: inputs.referenceUrl, referenceImage: inputs.referenceImage }));
      if (!readJson(at('reference-report.json'))) {
        const image = await reporter.upload(readFileSync(at('reference.png')));
        reporter.send([{ kind: 'reference', image, url: reference.url, width: reference.width, height: reference.height }]);
        writeJson(at('reference-report.json'), { image });
      }
      await tool('scaffold.mjs', [state.slug, '--codebase', codebase, '--brief', briefId, '--title', state.title]);
      state.workspace = readJson(at('workspace.json'));
      if (state.workspace?.slug !== state.slug || !existsSync(state.workspace.path)) need('Workspace checkpoint does not match the claimed slug.');
      state.stages.prepare = { reference: reference.sha256 }; save();
      if (!resumePreparation || ['connect', 'review'].includes(previousWorkflow.step)) {
        reporter.send([
          workflowEvent(runDir, 'connect', 'Verified the laptop and saved request', 'completed'),
          workflowEvent(runDir, 'copy', 'Preparing the screenshot baseline from local source'),
        ]);
      }
      await reporter.flush();
      return done({ status: 'needs-agent', inputs, workspace: state.workspace, reference, sourcePath: record.source.path, sourceRoute: new URL(reference.url).pathname, componentMap: at('components.json'), next: 'Implement the screenshot baseline from local source components; write components.json, then run check-baseline.' });
    }
    state.workspace ??= readJson(at('workspace.json')); state.slug ??= brief.prototype_slug; state.title ??= brief.title;
    if (!state.workspace || state.workspace.slug !== state.slug || state.slug !== brief.prototype_slug || !existsSync(state.workspace.path)) need('Run prepare to establish a matching claimed workspace.');
    const workspace = state.workspace.path;
    const reference = await (deps.prepareReference ?? prepareReference)({ runDir, referenceUrl: inputs.referenceUrl, referenceImage: inputs.referenceImage });
    if (!reference || reference.url !== inputs.referenceUrl || reference.image !== inputs.referenceImage) need('Saved reference differs from the brief. Preserve the original and resolve the request.');
    let map;
    try { map = validateComponentMap(readJson(at('components.json')), reference, record.source.path); } catch (error) { need(error.message, 'needs-agent'); }
    const workspaceHash = fingerprint(workspace);
    const key = hash(JSON.stringify({ workspaceHash, reference: reference.sha256, map, capture: { width: reference.width, height: reference.height, dpr: 1, readiness: 1, threshold: TAIL.PAGE_PROCEED_PCT } }));
    if (stage === 'check-baseline') {
      const history = state.baselineHistory ??= []; let baseline = state.baseline;
      if (baseline?.questionId && baseline.key !== key) {
        const previousAnswer = await waitForAnswer(build, baseline.questionId);
        if (previousAnswer.status === 'needs-input') return done(previousAnswer);
      }
      if (baseline?.key !== key) {
        const checked = await measure('browser', 'baseline', () => (deps.checkScreenshot ?? checkScreenshot)({ runDir, reference, workspace, parts: map.parts }));
        baseline = { key, workspaceHash, mapHash: hash(JSON.stringify(map)), checked, status: checked.gate.proceed ? 'passed' : 'differs' }; state.baseline = baseline;
        if (!history.includes(key)) history.push(key); save();
      } else state.timings.push({ kind: 'cache-hit', name: 'baseline', ms: 0 });
      // Reporting has its own checkpoint. A failed image upload or delivery
      // resumes from the captured evidence instead of silently dropping passes.
      if (!baseline.reported) {
        baseline.revision ??= workflow.revision;
        baseline.images ??= {}; baseline.passNumbers ??= {}; save();
        const reportId = (kind, id) => hash(`${baseline.key}:${kind}:${id}`);
        for (const part of map.parts) reporter.send([
          { kind: 'found', reportId: reportId('found', part.marker), id: part.marker, parent: null, raw: 'Source component', rect: part.rect },
          { kind: 'named', reportId: reportId('named', part.marker), id: part.marker, name: part.name, role: part.role ?? 'leaf', marker: part.marker },
        ]);
        for (const part of baseline.checked.parts) {
          if (part.image && !baseline.images[part.id]) { baseline.images[part.id] = await reporter.upload(readFileSync(part.image)); save(); }
          const image = baseline.images[part.id];
          baseline.passNumbers[part.id] ??= nextPassFor(runDir, part.id); save();
          reporter.send([{ kind: 'pass', reportId: reportId('pass', part.id), revision: baseline.revision, id: part.id,
            pass: baseline.passNumbers[part.id], mismatch: part.mismatch, ...(image ? { image } : {}) }]);
          if (part.status === 'matched') reporter.send([{ kind: 'matched', reportId: reportId('matched', part.id), id: part.id, rect: part.rect, ...(image ? { image } : {}) }]);
        }
        await reporter.flush(); baseline.reported = true; save();
      }
      if (baseline.status === 'differs') {
        if (history.length < 3) return done({ status: 'needs-agent', diagnostics: baseline.checked, repairsRemaining: 3 - history.length, next: 'Fix the visual differences, then rerun check-baseline. An unchanged retry reuses this result.' });
        const parts = baseline.checked.parts;
        const area = p => p.rect.w * p.rect.h;
        const copied = Math.round(100 * parts.filter(p => p.status === 'matched').reduce((n,p)=>n+area(p),0) / parts.reduce((n,p)=>n+area(p),0));
        baseline.questionId ??= await ask({ ...build, questionKey: `baseline-${key}` }, { form: 'copy-gate', text: 'Start building before the copy is finished?', impact: baseline.checked.gate.line.slice(0, 500), options: [{ id: 'finish', label: 'Not yet, finish it' }, { id: 'build', label: 'Yes, start building' }], recommended: 'finish', copied, missing: parts.filter(p => p.status !== 'matched').map(p => p.id).slice(0, 40) }); save();
        const answer = await waitForAnswer(build, baseline.questionId);
        if (answer.status === 'needs-input') return done(answer);
        if (answer.by !== 'option' || answer.option !== 'build') return done({ status: 'needs-agent', answer, diagnostics: baseline.checked, next: 'Apply the user reply and change the baseline before checking again. This answer does not accept the current differences.' });
        baseline.status = 'accepted'; baseline.answer = answer; save();
      }
      writeJson(at('parts.json'), { parts: baseline.checked.parts, sections: baseline.checked.parts.filter(p => p.role === 'section'), replicate: baseline.checked });
      state.host = await measure('hosting', 'start', () => (deps.hostPrototype ?? hostPrototype)({ workspace, codebase, briefId, title: state.title, rpc }));
      state.stages.baseline = { key, status: baseline.status }; save();
      reporter.send([workflowEvent(runDir, 'copy', 'Baseline verified or explicitly accepted', 'completed'), workflowEvent(runDir, 'build', 'Applying the requested change')]);
      await reporter.flush();
      return done({ status: 'needs-agent', inputs, baseline: state.stages.baseline, preview: state.host, next: 'Apply the requested change, exercise its interactions, then run finish with the changed markers.' });
    }
    if (!state.stages.baseline || state.stages.baseline.key !== state.baseline?.key || !['passed', 'accepted'].includes(state.baseline?.status)) need('Run check-baseline before finish.', 'needs-agent');
    if (state.baseline.mapHash !== hash(JSON.stringify(map))) need('The component map changed after baseline verification. Recheck the baseline before finishing.', 'needs-agent');
    const changedIds = [...new Set(changed.split(',').map(s => s.trim()).filter(Boolean))].sort();
    const manifest = readJson(join(workspace, 'public/prototype.json'));
    for (const marker of (manifest.variantSets ?? []).map(set => set.component)) if (!changedIds.includes(marker)) changedIds.push(marker);
    const known = new Set(map.parts.map(p => p.marker));
    if (changedIds.some(id => !known.has(id))) need('Changed markers must be declared in components.json.', 'needs-agent');
    const verifyKey = hash(JSON.stringify({ workspaceHash, changedIds, baseline: state.stages.baseline.key }));
    const checkArgs = [workspace, '--brief', briefId, '--codebase', codebase, ...(noSend ? ['--no-send'] : [])];
    if (state.stages.verify?.key !== verifyKey) {
      await command('pnpm', ['typecheck'], workspace); await tool('verify-markers.mjs', [workspace]);
      const output = await tool('check-states.mjs', [...checkArgs, '--changed', changedIds.join(',')]);
      const checked = JSON.parse(output.trim().split('\n').at(-1));
      if (!checked.ok) need(`State checks failed: ${JSON.stringify(checked)}`, 'needs-agent');
      const outputPreviews = await tool('previews.mjs', checkArgs); const previews = JSON.parse(outputPreviews.trim().split('\n').at(-1));
      if (previews.missing?.length) need(`Missing previews: ${JSON.stringify(previews.missing)}`, 'needs-agent');
      state.stages.verify = { key: verifyKey }; save();
    } else state.timings.push({ kind: 'cache-hit', name: 'verify', ms: 0 });
    reporter.send([
      workflowEvent(runDir, 'check', 'Verified prototype views, markers and previews', 'completed'),
      workflowEvent(runDir, 'publish', 'Building and publishing the verified prototype'),
    ]);
    await reporter.flush();
    const dist = join(workspace, 'dist');
    if (state.stages.build?.key !== verifyKey || !existsSync(dist) || fingerprint(dist, { output: true }) !== state.stages.build.outputHash) {
      await command('pnpm', ['build'], workspace); state.stages.build = { key: verifyKey, outputHash: fingerprint(dist, { output: true }) }; save();
    }
    state.host = await measure('hosting', 'verify', () => (deps.hostPrototype ?? hostPrototype)({ workspace, codebase, briefId, title: state.title, rpc, verify: true })); save();
    await tool('publish.mjs', ['--kind', 'prototype', workspace, '--defer-completion']);
    const publication = readJson(at('publication.json'));
    if (publication?.status !== 'verified' || publication.outputHash !== state.stages.build.outputHash) throw new Error('No verified publication for this output.');
    state.publication = publication; save();
    await (deps.flushQuestionHistory ?? flushQuestionHistory)(build); await reporter.flush();
    const urls = { frame: `${config.app.replace(/\/$/, '')}/p/${state.slug}`, live: state.host.liveUrl, published: publication.publishedUrl };
    if (state.host.tunnel === 'blocked') {
      await rpc('report_progress', { briefId, status: 'failed', message: TUNNEL_BLOCKED_SENTENCE }); return done({ status: 'retryable-error', urls, next: TUNNEL_BLOCKED_SENTENCE });
    }
    if (!state.host.liveUrl) return done({ status: 'retryable-error', urls, next: 'Published output is available; retry finish to verify the live endpoint.' });
    if (fingerprint(workspace) !== workspaceHash) need('Workspace changed during verification. Rerun finish for the latest files.', 'needs-agent');
    reporter.send([workflowEvent(runDir, 'publish', 'Published and verified the prototype', 'completed')]);
    await reporter.flush();
    await rpc('report_progress', { briefId, status: 'done', prototypeSlug: state.slug, message: 'Published and verified' });
    state.stages.finish = { key: verifyKey, urls }; save(); return done({ status: 'done', urls });
  } catch (error) {
    const status = error.status ?? (error.name === 'RenderError' ? 'needs-agent' : 'retryable-error');
    if (run && ['needs-agent', 'needs-input'].includes(status)) run.state.waiting = { kind: status === 'needs-agent' ? 'awaiting-agent' : 'awaiting-user', stage, since: Date.now() };
    if (status === 'needs-input') await rawRpc('report_progress', { briefId, status: 'needs-input', message: error.message.slice(0, 500) }).catch(() => {});
    return { status, stage, briefId, diagnostics: error.diagnostics ?? [error.message], next: 'Resolve the reported issue and rerun this stage; completed work is preserved.' };
  } finally {
    if (run) { run.state.timings.push({ kind: 'stage', name: stage, ms: Date.now() - stageStarted }); run.save(); }
    release();
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [stage, briefId, ...args] = process.argv.slice(2); const options = { stage, briefId };
  try {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--no-send') options.noSend = true;
      else if (['--codebase', '--title', '--changed'].includes(args[i]) && args[i+1]) options[args[i].slice(2)] = args[++i];
      else throw new Error(`Unknown or valueless option ${args[i]}`);
    }
    const result = await runBuild(options); console.log(JSON.stringify(result)); if (result.status === 'retryable-error') process.exitCode = 1;
  } catch (error) { console.log(JSON.stringify({ status: 'retryable-error', stage, briefId, diagnostics: [error.message] })); process.exitCode = 1; }
}
