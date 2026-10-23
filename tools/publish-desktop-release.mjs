#!/usr/bin/env node
/** Publish an already generated GitHub release to Blob, then promote its channel. */
import { promoteRelease } from './desktop-manifest.mjs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, createPublicKey, sign, verify } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
const root = resolve(process.argv[2] ?? '');
const release = JSON.parse(await readFile(join(root, '.proto-release.json'), 'utf8'));
if (!/^0\.1\.0\+codex\.\d{14}$/.test(release.version)) throw new Error('Use the GitHub-generated release snapshot.');
const { DESKTOP_BLOB_READ_WRITE_TOKEN: token, DESKTOP_ARTIFACT_PRIVATE_KEY: key, DESKTOP_RELEASE_MANIFEST_URL: current, DESKTOP_RELEASE_CHANNEL: channel, DESKTOP_BLOB_SDK: sdk } = process.env;
if (!token || !key || !current || !sdk || !/^[a-zA-Z0-9_-]+$/.test(channel ?? '')) throw new Error('Desktop release publishing is not configured.');
const { get, put } = createRequire(join(resolve(sdk), 'package.json'))('@vercel/blob');
const response = await fetch(current, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
if (!response.ok) throw new Error(`Current desktop manifest unavailable (${response.status}).`);
const manifest = await response.json();
if (manifest.format !== 1 || !Array.isArray(manifest.kits)) throw new Error('Invalid current manifest.');
const existing = manifest.kits.find(item => item.version === release.version);
if (existing) {
  const { kind, version, bridgeVersion, sha256, bytes, url, signature } = existing;
  const payload = JSON.stringify({ kind, version, bridgeVersion, sha256, bytes, url });
  if (kind !== 'kit' || !verify(null, Buffer.from(payload), createPublicKey(key), Buffer.from(signature ?? '', 'base64'))) throw new Error('Existing kit has an invalid signature.');
  const location = new URL(url);
  if (location.protocol !== 'https:' || location.username || location.password) throw new Error('Existing kit requires HTTPS.');
  const downloaded = await fetch(location, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
  if (!downloaded.ok) throw new Error('Existing kit cannot be read.');
  const contents = Buffer.from(await downloaded.arrayBuffer());
  if (contents.length !== bytes || createHash('sha256').update(contents).digest('hex') !== sha256) throw new Error('Existing kit failed verification.');
  console.log(JSON.stringify({ version: release.version, reused: true }));
  process.exit(0);
}
const files = [];
async function walk(directory, prefix = '') {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['.git', '.github', 'node_modules', 'evals', '.DS_Store'].includes(item.name)) continue;
    const path = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Refusing release symlink: ${path}`);
    if (item.isDirectory()) await walk(join(directory, item.name), path + '/');
    else if (item.isFile()) files.push({ path, mode: (await stat(join(directory, item.name))).mode & 0o111 ? 493 : 420, data: (await readFile(join(directory, item.name))).toString('base64') });
  }
}
await walk(root);
const bytes = gzipSync(JSON.stringify({ format: 1, files }), { level: 9 });
const digest = createHash('sha256').update(bytes).digest('hex');
const prefix = `desktop-releases/${channel}`;
const options = { token, access: 'public', addRandomSuffix: false, allowOverwrite: false, cacheControlMaxAge: 31536000 };
const pathname = `${prefix}/kits/${release.version}.kit.gz`;
let url;
try { url = (await put(pathname, bytes, { ...options, contentType: 'application/gzip' })).url; }
catch (error) {
  // A workflow retry may find the immutable object after its first upload.
  if (error.name !== 'BlobAlreadyExistsError') throw error;
  url = new URL('/' + pathname, current).href;
}
const downloaded = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(120000) });
if (!downloaded.ok) throw new Error('Uploaded kit cannot be read.');
const check = Buffer.from(await downloaded.arrayBuffer());
if (check.length !== bytes.length || createHash('sha256').update(check).digest('hex') !== digest) throw new Error('Uploaded kit failed verification.');
const artifact = { kind: 'kit', version: release.version, bridgeVersion: 1, sha256: digest, bytes: bytes.length, url };
artifact.signature = sign(null, Buffer.from(JSON.stringify(artifact)), key).toString('base64');
const next = { ...manifest, requiredKit: release.version, kits: [...manifest.kits, artifact], publishedAt: new Date().toISOString() };
await put(`${prefix}/manifests/${release.version}-${Date.now()}.json`, JSON.stringify(next), { ...options, contentType: 'application/json' });
await promoteRelease({ get, put, token, channel, staged: next, validate: async candidate => {
  if (!candidate.kits.some(item => item.version === candidate.requiredKit)) throw new Error('Required kit is missing.');
  for (const item of [...candidate.kits, ...(candidate.desktop ? [candidate.desktop] : [])]) {
    const { kind, version, bridgeVersion, sha256, bytes, url, signature } = item;
    const payload = JSON.stringify({ kind, version, bridgeVersion, sha256, bytes, url });
    if (!verify(null, Buffer.from(payload), createPublicKey(key), Buffer.from(signature ?? '', 'base64'))) throw new Error('Manifest artifact signature is invalid.');
  }
} });
console.log(JSON.stringify({ version: release.version, channel, published: true }));
