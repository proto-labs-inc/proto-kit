/** Transactional, non-agent rig maintenance. Journal lives outside the workspace. */
import { cp, mkdir, readFile, readdir, rename, rm, lstat, realpath } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, openSync, fsyncSync, closeSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireProcessLock } from './process-lock.mjs';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { publishError, readPublishStatus, startPublishAttempt, completePublishAttempt, failPublishAttempt } from './publish-status.mjs';
import { takeRunLock, refreshRunLock } from './run-lock.mjs';
import { protoHome } from './proto-home.mjs';
import { callTool } from './mcp-call.mjs';
import { resolvedRigVersion } from './rig-version.mjs';
import { verifyRigBuild } from './verify-rig-build.mjs';

const kit = dirname(dirname(fileURLToPath(import.meta.url)));
const excluded = new Set(['node_modules', 'dist', '.git', '.proto']);
export async function sourceFingerprint(root) {
  const hash = createHash('sha256');
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      if (dir === root && excluded.has(name)) continue;
      const path = join(dir, name), stat = await lstat(path);
      hash.update(relative(root, path) + '\0');
      if (stat.isSymbolicLink()) throw new Error('Source symlinks require a manual update.');
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) { hash.update(String(stat.mode)); hash.update(await readFile(path)); }
      else throw new Error('Special workspace files require a manual update.');
    }
  }
  await visit(root);
  return hash.digest('hex');
}
export function saveJournal(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const fd = openSync(file + '.tmp', 'w', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(file + '.tmp', file);
}
function run(args, cwd, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn('node', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-12000); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun(output) : reject(new Error(output || `Command failed (${code})`)));
  });
}
function unwrap(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(text || 'Publication did not respond.'); }
  if (result.isError || value.error) throw new Error(value.error || text);
  return value;
}
export async function maintainRig(file, { runCommand = run, verifyBuild = verifyRigBuild, finish = async input => unwrap(await callTool('finish_publish', input)), builtVersion = resolvedRigVersion } = {}) {
  const job = JSON.parse(await readFile(file, 'utf8'));
  if (![job.codebase, job.slug].every(id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(id))) throw new Error('Invalid prototype identity.');
  const home = await realpath(protoHome());
  const workspace = join(home, job.codebase, 'prototypes', job.slug);
  const root = dirname(file), staged = join(root, 'staged'), backup = join(root, 'backup');
  const parent = join(home, job.codebase, 'prototypes');
  if (await realpath(parent) !== parent || (existsSync(workspace) && await realpath(workspace) !== workspace)) throw new Error('Workspace symlinks require a manual update.');
  const runDir = join(protoHome(), job.codebase, 'run', job.slug);
  await mkdir(runDir, { recursive: true });
  const releasePreview = await acquireProcessLock(join(runDir, 'preview-start.lock'), { timeoutMs: 5000 }).catch(error => {
    job.error = 'Prototype preview is starting.'; job.failureKind = 'busy'; saveJournal(file, job); throw error;
  });
  const lock = join(runDir, 'maintenance.lock'), publishLock = join(runDir, 'publish.lock');
  for (const candidate of [lock, publishLock]) {
    // No live owner can exist before its PID was written; allow a bounded
    // startup window, then recover a crash in that tiny creation interval.
    if (existsSync(candidate) && !existsSync(join(candidate, 'pid')) && Date.now() - statSync(candidate).mtimeMs > 30000) await rm(candidate, { recursive: true, force: true });
  }
  if (!takeRunLock(lock, { staleMs: Infinity })) {
    await releasePreview(); job.error = 'Prototype maintenance is already running.'; job.failureKind = 'busy'; saveJournal(file, job); throw new Error(job.error);
  }
  let publishing = false;
  const heartbeat = setInterval(() => { refreshRunLock(lock); if (publishing) refreshRunLock(publishLock); }, 10000);
  heartbeat.unref();
  const env = { ...process.env, PROTO_MAINTENANCE_PID: String(process.pid), CI: 'true' };
  const save = () => saveJournal(file, job);
  const cleanup = async () => {
    try { await rm(backup, { recursive: true, force: true }); await rm(staged, { recursive: true, force: true }); }
    catch (error) { job.cleanupError = publishError(error); job.cleanupRetryAt = Date.now() + 3600000; save(); }
  };
  const stage = value => { job.stage = value; save(); console.log(JSON.stringify({ stage: value })); };
  try {
    publishing = takeRunLock(publishLock, { staleMs: Infinity });
    if (!publishing) { const error = new Error('Prototype is publishing.'); error.code = 'BUSY'; throw error; }
    const stateFile = join(runDir, 'state.json');
    const startFile = join(runDir, 'start.lock', 'owner.json');
    for (const path of [stateFile, startFile]) {
      if (!existsSync(path)) continue;
      const pid = JSON.parse(readFileSync(path, 'utf8')).pid;
      if (!Number.isInteger(pid) || pid < 1) continue;
      try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') continue; throw error; }
      const error = new Error('Prototype preview is still running.'); error.code = 'BUSY'; throw error;
    }
    // A crash between the two renames leaves the untouched original in backup.
    if (!existsSync(workspace) && existsSync(backup)) await rename(backup, workspace);
    const manifestPath = join(workspace, 'public/prototype.json');
    const port = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')).port : null;
    if (Number.isInteger(port) && port > 0 && port <= 65535 && await new Promise(resolveProbe => {
      const socket = createConnection({ host: 'localhost', port });
      const done = answer => { socket.destroy(); resolveProbe(answer); };
      socket.once('connect', () => done(true)); socket.once('error', error => done(error.code !== 'ECONNREFUSED'));
      socket.setTimeout(1000, () => done(true));
    })) { const error = new Error('A preview is listening on this prototype port.'); error.code = 'BUSY'; throw error; }
    if (job.stage === 'applying') {
      if (existsSync(backup) && await sourceFingerprint(workspace) === job.preparedFingerprint) stage('publishing');
      else if (await sourceFingerprint(workspace) === job.sourceFingerprint) stage('verified');
      else throw new Error('Workspace changed during recovery; manual attention required.');
    }
    if (job.stage === 'complete') { await cleanup(); return job; }
    if (job.stage === 'publishing') {
      if (await sourceFingerprint(workspace) !== job.preparedFingerprint) throw new Error('Workspace changed after preparation; manual attention required.');
    } else {
      if (job.stage !== 'verified') {
        job.sourceFingerprint = await sourceFingerprint(workspace);
        const pkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const adapter = deps['@proto-labs-inc/rig-vue'] ? '@proto-labs-inc/rig-vue' : '@proto-labs-inc/rig';
        if (!/^\d+\.\d+\.\d+$/.test(deps[adapter] || '')) throw new Error('Legacy or linked rigs require a manual update.');
        stage('preparing');
        await rm(staged, { recursive: true, force: true });
        await cp(workspace, staged, { recursive: true, filter: path => !['node_modules', 'dist'].includes(relative(workspace, path).split('/')[0]) });
        stage('building');
        await runCommand([join(kit, 'tools/update-rig.mjs'), staged], staged, env);
        stage('verifying');
        await verifyBuild(join(staged, 'dist'), builtVersion(staged));
        job.preparedFingerprint = await sourceFingerprint(staged);
        stage('verified');
      }
      if (await sourceFingerprint(workspace) !== job.sourceFingerprint) throw new Error('Workspace changed during preparation; manual attention required.');
      if (existsSync(backup)) throw new Error('Previous maintenance backup needs recovery.');
      stage('applying');
      await rename(workspace, backup);
      await rename(staged, workspace);
      stage('publishing');
    }
    const receipt = join(root, 'publish.json');
    const resultFile = join(root, 'publish-result.json');
    if (!existsSync(receipt)) {
      await runCommand([join(kit, 'tools/publish.mjs'), '--kind', 'prototype', workspace,
        '--codebase', job.codebase, '--slug', job.slug, '--auto', '--maintenance-job', resolve(file)], workspace, env);
    }
    let finished;
    if (existsSync(resultFile)) finished = JSON.parse(await readFile(resultFile, 'utf8'));
    else {
      const input = JSON.parse(await readFile(receipt, 'utf8'));
      const attempt = startPublishAttempt(workspace);
      try {
        finished = await finish(input);
        saveJournal(resultFile, finished);
        completePublishAttempt(workspace, attempt.attemptId, finished.publishedUrl);
      } catch (error) { failPublishAttempt(workspace, attempt.attemptId, error); throw error; }
    }
    if (typeof finished.publishedUrl !== 'string') throw new Error('Publication did not confirm its build URL.');
    const publication = readPublishStatus(workspace);
    if (publication?.status !== 'published' || publication.publishedUrl !== finished.publishedUrl) {
      const attempt = startPublishAttempt(workspace);
      completePublishAttempt(workspace, attempt.attemptId, finished.publishedUrl);
    }
    job.publishedUrl = finished.publishedUrl;
    stage('complete');
    await cleanup();
    return job;
  } catch (error) {
    job.error = publishError(error).slice(-2000);
    // Only transport/install outages are retried. Rendering/build/source failures need repair.
    job.failureKind = /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|HTTP 50[234]|EAI_AGAIN|ERR_PNPM_META_FETCH/.test(job.error) ? 'transient' : 'attention';
    if (error.code === 'BUSY') job.failureKind = 'busy';
    save();
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (publishing) await rm(publishLock, { recursive: true, force: true });
    await rm(lock, { recursive: true, force: true });
    await releasePreview();
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = Number(process.env.PROTO_MAINTENANCE_HOST_PID);
  // A force-killed desktop cannot leave an unattended writer running forever.
  const watchdog = setInterval(() => {
    if (!Number.isInteger(host) || host < 1) return;
    try { process.kill(host, 0); }
    catch (error) { if (error.code === 'ESRCH') { try { process.kill(-process.pid, 'SIGTERM'); } catch { process.exit(143); } } }
  }, 1000);
  watchdog.unref();
  maintainRig(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
