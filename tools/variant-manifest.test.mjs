import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeVariantSet, readVariantSet, validateVariantSets, validatePublishedManifest, recordVariantPreviews } from './variant-manifest.mjs';
const tool = name => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
const loading = component => ({ component, title: component, status: 'building', variants: [], default: '' });
const complete = component => ({ component, title: component, variants: [{ id: 'one', title: 'One', sourceFiles: [`src/variants/${component}/one.tsx`], preview: `previews/${component}.svg` }], default: 'one', state: 'detail' });
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'proto-variant-guard-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'public'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/App.tsx'), '<main><div data-proto-id="location-world-map" /><div data-proto-id="country-detail" /></main>');
    const manifest = { name: 'graph', states: [{ id: 'detail' }], variantSets: [complete('location-world-map'), complete('location-map-highlight')], extra: { keep: true } };
    writeFileSync(join(root, 'public/prototype.json'), JSON.stringify(manifest));
    return { root, manifest, path: join(root, 'public/prototype.json') };
}
test('creating Graph styles preserves both existing map sets, states and unknown fields, and backs up exact bytes', t => {
    const { root, manifest, path } = fixture(t);
    const before = readFileSync(path, 'utf8');
    const result = writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') });
    const after = JSON.parse(readFileSync(path));
    assert.deepEqual(after, { ...manifest, variantSets: [...manifest.variantSets, result.entry] });
    assert.equal(readFileSync(result.backup, 'utf8'), before);
    assert.equal(existsSync(path + '.lock'), false);
});
test('same target and title create distinct sets without changing existing sets or dependents', t => {
    const { root, manifest, path } = fixture(t);
    const parent = manifest.variantSets[0];
    const child = writeVariantSet(root, { operation: 'create', component: 'child', entry: { ...loading('child'), requires: { component: parent.component, variant: 'one' } } });
    const first = writeVariantSet(root, { operation: 'create', component: parent.component, entry: loading(parent.component) });
    const second = writeVariantSet(root, { operation: 'create', component: parent.component, entry: loading(parent.component) });
    assert.notEqual(first.entry.id, second.entry.id);
    assert.notEqual(first.entry.component, second.entry.component);
    assert.equal(first.entry.component, `set-${first.entry.id}`);
    assert.equal(second.entry.component, `set-${second.entry.id}`);
    assert.equal(first.entry.title, second.entry.title);
    assert.deepEqual(first.entry.regions, [parent.component]);
    assert.deepEqual(JSON.parse(readFileSync(path)).variantSets, [...manifest.variantSets, child.entry, first.entry, second.entry]);
});
test('legacy scaffold cannot overwrite an existing set or switch', t => {
    const { root, path } = fixture(t);
    const dir = join(root, 'src/variants/location-world-map');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.tsx'), 'KEEP');
    const res = spawnSync(process.execPath, [tool('variant-set'), root, 'location-world-map', '--expected', readVariantSet(root, 'location-world-map').revision, '--title', 'Wrong', '--variants', 'new=New', '--default', 'new', '--no-send'], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /already/);
    assert.equal(readFileSync(join(dir, 'index.tsx'), 'utf8'), 'KEEP');
    assert.equal(existsSync(join(dir, 'new.tsx')), false);
    assert.equal(JSON.parse(readFileSync(path)).variantSets.length, 2);
});
test('scaffold uses the registered unique set address and original DOM marker without changing neighbors', t => {
    const { root, manifest, path } = fixture(t);
    const started = writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') });
    const res = spawnSync(process.execPath, [tool('variant-set'), root, started.entry.component, '--expected', started.revision, '--title', 'Graphs', '--variants', 'bars=Bars;line=Line', '--default', 'bars', '--no-send'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path)).variantSets.slice(0, 2), manifest.variantSets);
    const result = JSON.parse(res.stdout);
    assert.equal(result.id, started.entry.id);
    assert.equal(result.component, started.entry.component);
    assert.ok(readFileSync(join(root, result.switch.module), 'utf8').includes(`useVariant("${started.entry.component}"`));
    assert.match(readFileSync(join(root, result.variants[0].module), 'utf8'), /data-proto-id="country-detail"/);
    assert.deepEqual(readVariantSet(root, result.component).entry.regions, ['country-detail']);
    assert.equal(JSON.parse(readFileSync(path)).variantSets.length, 3);
});
test('finishing updates only its loading set even when another set was added since begin', t => {
    const { root, manifest, path } = fixture(t);
    const started = writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') });
    const another = writeVariantSet(root, { operation: 'create', component: 'another', entry: loading('another') });
    writeVariantSet(root, { operation: 'finish', component: started.entry.component, entry: { ...complete(started.entry.component), regions: started.entry.regions }, expectedRevision: started.revision });
    const sets = JSON.parse(readFileSync(path)).variantSets;
    assert.deepEqual(sets.slice(0, 2), manifest.variantSets);
    assert.deepEqual(sets[2], { ...complete(started.entry.component), id: started.entry.id, regions: started.entry.regions });
    assert.deepEqual(sets[3], another.entry);
});
test('stale edits cannot erase a newer edit', t => {
    const { root, path } = fixture(t);
    const snapshot = readVariantSet(root, 'location-world-map');
    writeVariantSet(root, { operation: 'update', component: 'location-world-map', entry: { ...snapshot.entry, title: 'New title' }, expectedRevision: snapshot.revision });
    const before = readFileSync(path, 'utf8');
    assert.throws(() => writeVariantSet(root, { operation: 'update', component: 'location-world-map', entry: snapshot.entry, expectedRevision: snapshot.revision }), /changed since/);
    assert.equal(readFileSync(path, 'utf8'), before);
});
test('wrong target and resetting a completed set to loading are refused', t => {
    const { root } = fixture(t);
    const snapshot = readVariantSet(root, 'location-world-map');
    assert.throws(() => writeVariantSet(root, { operation: 'update', component: 'location-world-map', entry: loading('wrong'), expectedRevision: snapshot.revision }), /explicit target/);
    assert.throws(() => writeVariantSet(root, { operation: 'update', component: 'location-world-map', entry: loading('location-world-map'), expectedRevision: snapshot.revision }), /reset/);
});
test('an existing write lock is respected and never removed by a second writer', t => {
    const { root, path } = fixture(t);
    writeFileSync(path + '.lock', 'active');
    assert.throws(() => writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') }), /being edited/);
    assert.equal(readFileSync(path + '.lock', 'utf8'), 'active');
});
test('simultaneous creates do not lose either set; a busy writer can retry', async (t) => {
    const { root, path } = fixture(t);
    const run = component => new Promise(resolve => { const child = spawn(process.execPath, [tool('variant-manifest'), 'begin', root, component, '--title', component]); let err = ''; child.stderr.on('data', data => err += data); child.on('exit', code => resolve({ component, code, err })); });
    const results = await Promise.all([run('country-detail'), run('another')]);
    for (const result of results)
        if (result.code) {
            assert.match(result.err, /being edited/);
            assert.equal((await run(result.component)).code, 0);
        }
    const created = JSON.parse(readFileSync(path)).variantSets.slice(2);
    assert.equal(created.length, 2);
    assert.deepEqual(created.map(set => set.regions[0]).sort(), ['another', 'country-detail']);
    assert.equal(new Set(created.map(set => set.id)).size, 2);
});
test('validation catches the observed misplaced map variants and duplicate identities', () => {
    assert.throws(() => validateVariantSets({ variantSets: [{ ...complete('location-world-map'), component: 'location-map-highlight' }] }), /source belongs to location-world-map/);
    assert.throws(() => validateVariantSets({ variantSets: [loading('map'), loading('map')] }), /duplicate component/);
    assert.throws(() => validateVariantSets({ variantSets: [{ ...complete('map'), variants: [{ id: 'a', title: 'A' }, { id: 'a', title: 'A' }] }] }), /duplicate variant/);
});
test('validation rejects bad defaults, references, dependencies and empty finished sets', () => {
    for (const entry of [{ ...complete('map'), default: 'absent' }, { ...complete('map'), references: [{ variant: 'absent' }] }, { ...complete('map'), requires: { component: 'absent', variant: 'one' } }, { ...loading('map'), status: undefined }])
        assert.throws(() => validateVariantSets({ states: [{ id: 'detail' }], variantSets: [entry] }));
});
function built(t) { const f = fixture(t); mkdirSync(join(f.root, 'dist/previews'), { recursive: true }); writeFileSync(join(f.root, 'dist/index.html'), '<html></html>'); for (const set of f.manifest.variantSets) {
    const source = join(f.root, set.variants[0].sourceFiles[0]);
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, 'export default 1');
    writeFileSync(join(f.root, 'dist', set.variants[0].preview), '<svg/>');
} writeFileSync(join(f.root, 'dist/prototype.json'), JSON.stringify(f.manifest)); return f; }
test('publish accepts valid assets, rejects missing sources and previews, and rejects a stale build', t => {
    const { root, path } = built(t);
    const dist = join(root, 'dist');
    assert.doesNotThrow(() => validatePublishedManifest(root, dist));
    const source = join(root, 'src/variants/location-world-map/one.tsx');
    rmSync(source);
    assert.throws(() => validatePublishedManifest(root, dist), /missing file/);
    writeFileSync(source, 'restored');
    const preview = join(dist, 'previews/location-world-map.svg');
    rmSync(preview);
    assert.throws(() => validatePublishedManifest(root, dist), /missing file/);
    writeFileSync(preview, '<svg/>');
    const manifest = JSON.parse(readFileSync(path));
    manifest.variantSets[0].title = 'Edited';
    writeFileSync(path, JSON.stringify(manifest));
    assert.throws(() => validatePublishedManifest(root, dist), /changed since the build/);
});
test('publish CLI refuses a building set before attempting credentials or upload', t => {
    const { root } = built(t);
    writeFileSync(join(root, 'dist/prototype.json'), JSON.stringify({ variantSets: [loading('country-detail')] }));
    const res = spawnSync(process.execPath, [tool('publish'), '--kind', 'prototype', root, '--codebase', 'test', '--slug', 'test', '--dry-run'], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /country-detail: still building/);
    assert.doesNotMatch(res.stdout, /would upload/);
});
test('the CLI begins and finishes a dependent set with a checked revision', t => {
    const { root, manifest } = fixture(t);
    const begin = spawnSync(process.execPath, [tool('variant-manifest'), 'begin', root, 'country-detail', '--title', 'Graphs', '--requires-component', 'location-world-map', '--requires-variant', 'one'], { encoding: 'utf8' });
    assert.equal(begin.status, 0, begin.stderr);
    const started = JSON.parse(begin.stdout);
    assert.deepEqual(started.entry.requires, { component: 'location-world-map', variant: 'one' });
    const entry = { ...complete(started.entry.component), id: started.entry.id, regions: started.entry.regions, requires: started.entry.requires };
    const input = join(root, 'entry.json');
    writeFileSync(input, JSON.stringify(entry));
    const finish = spawnSync(process.execPath, [tool('variant-manifest'), 'finish', root, started.entry.component, '--entry', input, '--expected', started.revision], { encoding: 'utf8' });
    assert.equal(finish.status, 0, finish.stderr);
    assert.deepEqual(readVariantSet(root, started.entry.component).entry, { ...entry, id: started.entry.id });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'public/prototype.json'))).variantSets.slice(0, 2), manifest.variantSets);
});
test('preview completion leaves unrelated empty loading entries building', t => {
    const { root, manifest } = fixture(t);
    const started = writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') });
    const snapshot = JSON.parse(readFileSync(join(root, 'public/prototype.json')));
    recordVariantPreviews(root, snapshot, [{ component: 'location-world-map', variant: 'one', file: 'previews/new.svg', background: '#fff' }]);
    assert.equal(readVariantSet(root, started.entry.component).entry.status, 'building');
    assert.deepEqual(readVariantSet(root, 'location-map-highlight').entry, manifest.variantSets[1]);
    assert.equal(readVariantSet(root, 'location-world-map').entry.variants[0].preview, 'previews/new.svg');
});
test('previews captured before a same-set edit cannot overwrite that edit', t => {
    const { root, manifest } = fixture(t);
    const current = readVariantSet(root, 'location-world-map');
    writeVariantSet(root, { operation: 'update', component: 'location-world-map', entry: { ...current.entry, title: 'Updated' }, expectedRevision: current.revision });
    assert.throws(() => recordVariantPreviews(root, manifest, [{ component: 'location-world-map', variant: 'one', file: 'previews/new.svg' }]), /changed since/);
    assert.equal(readVariantSet(root, 'location-world-map').entry.title, 'Updated');
});


test('CLI rejects the removed replacement option without changing the manifest', t => {
    const { root, path } = fixture(t);
    const before = readFileSync(path, 'utf8');
    const result = spawnSync(process.execPath, [tool('variant-manifest'), 'begin', root, 'location-world-map', '--title', 'Graphs', '--replaces', 'location-world-map'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown or missing option --replaces/);
    assert.equal(readFileSync(path, 'utf8'), before);
});

test('editing cannot change the set identity', t => {
    const { root } = fixture(t);
    const started = writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') });
    assert.throws(() => writeVariantSet(root, { operation: 'update', component: started.entry.component, entry: { ...started.entry, id: 'wrong' }, expectedRevision: started.revision }), /cannot change/);
});

test('references-only completion publishes assets and keeps identity for the first variants', t => {
    const { root } = built(t);
    const started = writeVariantSet(root, { operation: 'create', component: 'country-detail', entry: loading('country-detail') });
    const references = [{ app: 'Example', url: 'https://example.test/list', image: 'references/list.webp', note: 'Grouped rows' }];
    const entry = { ...started.entry, references };
    delete entry.status;
    const finished = writeVariantSet(root, { operation: 'finish', component: entry.component, entry, expectedRevision: started.revision });
    assert.equal(finished.entry.id, started.entry.id);
    assert.deepEqual(finished.entry.variants, []);
    assert.equal(finished.entry.default, '');
    const dist = join(root, 'dist');
    mkdirSync(join(dist, 'references'));
    writeFileSync(join(dist, 'references/list.webp'), 'image fixture');
    writeFileSync(join(dist, 'prototype.json'), readFileSync(join(root, 'public/prototype.json')));
    assert.doesNotThrow(() => validatePublishedManifest(root, dist));
    rmSync(join(dist, 'references/list.webp'));
    assert.throws(() => validatePublishedManifest(root, dist), /missing file/);
    const res = spawnSync(process.execPath, [tool('variant-set'), root, entry.component, '--expected', finished.revision, '--title', 'Lists', '--variants', 'rows=Rows', '--default', 'rows', '--no-send'], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    const next = readVariantSet(root, entry.component).entry;
    assert.equal(next.id, entry.id);
    assert.deepEqual(next.references, references);
    assert.equal(next.variants[0].id, 'rows');
});

test('references-only completion requires usable visual references and an empty default', () => {
    const ref = { app: 'Example', url: 'https://example.test/list', image: 'references/list.webp', note: 'Grouped rows' };
    const set = { component: 'list', default: '', variants: [], references: [ref] };
    assert.doesNotThrow(() => validateVariantSets({ variantSets: [set] }));
    for (const key of ['app', 'url', 'image', 'note']) {
        assert.throws(() => validateVariantSets({ variantSets: [{ ...set, references: [{ ...ref, [key]: '' }] }] }), /visual references need/);
    }
    assert.throws(() => validateVariantSets({ variantSets: [{ ...set, default: 'absent' }] }), /empty default/);
    assert.throws(() => validateVariantSets({ variantSets: [{ ...set, references: [{ ...ref, variant: 'absent' }] }] }), /unknown variant/);
});
