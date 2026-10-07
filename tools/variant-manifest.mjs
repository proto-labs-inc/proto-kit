#!/usr/bin/env node
// One targeted manifest write, protected against duplicate creation and stale edits.
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, openSync, closeSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
export const revisionOf = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function check(condition, message) { if (!condition)
    throw new Error(message); }
function fileAt(root, path, label) {
    check(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\'), `${label}: use a relative file path`);
    const full = resolve(root, path);
    const rel = relative(resolve(root), full);
    check(rel !== '..' && !rel.startsWith(`..${sep}`), `${label}: path leaves its root`);
    check(existsSync(full) && statSync(full).isFile(), `${label}: missing file ${path}`);
}
export function validateVariantSets(manifest, { mode = 'working', workspace, assets } = {}) {
    check(object(manifest), 'prototype.json must be an object');
    const sets = manifest.variantSets ?? [];
    check(Array.isArray(sets), 'variantSets must be an array');
    const components = new Set();
    for (const set of sets) {
        check(object(set) && idPattern.test(set.component ?? ''), 'each variant set needs a component ID');
        const label = set.component;
        check(!components.has(label), `duplicate component ${label}`);
        components.add(label);
        check(set.title === undefined || (typeof set.title === 'string' && set.title.trim()), `${label}: title is required`);
        check(Array.isArray(set.variants), `${label}: variants must be an array`);
        check(set.status === undefined || set.status === 'building', `${label}: unknown status`);
        if (mode === 'publish')
            check(set.status !== 'building', `${label}: still building`);
        const ids = new Set();
        for (const variant of set.variants) {
            check(object(variant) && idPattern.test(variant.id ?? ''), `${label}: each variant needs an ID`);
            check(!ids.has(variant.id), `${label}: duplicate variant ${variant.id}`);
            ids.add(variant.id);
            check(typeof variant.title === 'string' && variant.title.trim(), `${label}/${variant.id}: title is required`);
            if (variant.sourceFiles !== undefined) {
                check(Array.isArray(variant.sourceFiles) && variant.sourceFiles.every(f => typeof f === 'string'), `${label}/${variant.id}: sourceFiles must be an array of paths`);
                // A module in another variant-set directory is a misplaced registration.
                for (const source of variant.sourceFiles) {
                    const owner = source.match(/^src\/variants\/([^/]+)\//)?.[1];
                    check(!owner || owner === label, `${label}/${variant.id}: source belongs to ${owner}`);
                    if (mode === 'publish' && workspace)
                        fileAt(workspace, source, `${label}/${variant.id}`);
                }
            }
            if (mode === 'publish') {
                check(variant.id === set.baseline || variant.sourceFiles?.length > 0, `${label}/${variant.id}: sourceFiles are required`);
                check(typeof variant.preview === 'string', `${label}/${variant.id}: preview is required`);
                if (assets)
                    fileAt(assets, variant.preview, `${label}/${variant.id} preview`);
            }
        }
        if (set.status === 'building' && ids.size === 0)
            check(set.default === '', `${label}: an empty building set needs an empty default`);
        else
            check(ids.size > 0 && ids.has(set.default), `${label}: default must name a registered variant`);
        if (set.baseline !== undefined)
            check(ids.has(set.baseline), `${label}: baseline must name a registered variant`);
        if (set.state !== undefined)
            check(manifest.states?.some(state => state.id === set.state), `${label}: unknown showcase state ${set.state}`);
        if (set.references !== undefined) {
            check(Array.isArray(set.references), `${label}: references must be an array`);
            for (const ref of set.references) {
                check(object(ref) && (ref.variant === undefined || ids.has(ref.variant)), `${label}: reference names an unknown variant`);
                if (mode === 'publish' && assets && ref.image && !/^https?:\/\//.test(ref.image))
                    fileAt(assets, ref.image, `${label} reference`);
            }
        }
    }
    const byComponent = new Map(sets.map(set => [set.component, set]));
    for (const set of sets) {
        const visited = new Set([set.component]);
        let current = set;
        while (current.requires) {
            const parent = byComponent.get(current.requires.component);
            check(parent?.variants.some(v => v.id === current.requires.variant), `${current.component}: invalid variant-set requirement`);
            check(!visited.has(parent.component), `${set.component}: cyclic variant-set requirement`);
            visited.add(parent.component);
            current = parent;
        }
    }
}
export function readVariantSet(workspace, component) {
    const manifest = JSON.parse(readFileSync(join(workspace, 'public/prototype.json'), 'utf8'));
    validateVariantSets(manifest);
    const entry = manifest.variantSets?.find(set => set.component === component);
    check(entry, `no variant set ${component}`);
    return { entry, revision: revisionOf(entry) };
}
export function writeVariantSet(workspace, { operation, component, entry, expectedRevision }) {
    check(['create', 'update', 'finish'].includes(operation), 'operation must be create, update, or finish');
    check(entry?.component === component, 'entry component must match the explicit target');
    const path = join(workspace, 'public/prototype.json');
    const lock = `${path}.lock`;
    let fd;
    try {
        fd = openSync(lock, 'wx');
    }
    catch (error) {
        if (error.code === 'EEXIST')
            throw new Error('prototype.json is being edited; retry after the other writer finishes');
        throw error;
    }
    let temp;
    try {
        const original = readFileSync(path, 'utf8');
        const manifest = JSON.parse(original);
        validateVariantSets(manifest);
        const sets = manifest.variantSets ?? [];
        const index = sets.findIndex(set => set.component === component);
        if (operation === 'create')
            check(index === -1, `${component} already exists; creation cannot replace an existing set`);
        else {
            check(index !== -1, `no variant set ${component}`);
            check(expectedRevision && revisionOf(sets[index]) === expectedRevision, `${component} changed since it was read; read it again before editing`);
            if (operation === 'finish')
                check(sets[index].status === 'building' && entry.status === undefined, 'finish requires a building set and a completed entry');
            else
                check(!(sets[index].variants.length && entry.variants?.length === 0), 'cannot reset an existing set to an empty loading entry');
        }
        const next = structuredClone(entry);
        if (index === -1)
            sets.push(next);
        else
            sets[index] = next;
        manifest.variantSets = sets;
        validateVariantSets(manifest);
        const backupDir = join(workspace, '.proto/manifest-backups');
        mkdirSync(backupDir, { recursive: true });
        const backup = join(backupDir, `${Date.now()}-${randomUUID()}.json`);
        writeFileSync(backup, original, { flag: 'wx' });
        temp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
        check(readFileSync(path, 'utf8') === original, 'prototype.json changed outside the writer; no changes saved');
        renameSync(temp, path);
        temp = undefined;
        return { entry: next, revision: revisionOf(next), backup };
    }
    finally {
        if (temp)
            rmSync(temp, { force: true });
        closeSync(fd);
        rmSync(lock, { force: true });
    }
}
export function recordVariantPreviews(workspace, manifest, previews) {
    for (const original of manifest.variantSets ?? []) {
        const madeForSet = previews.filter(p => p.component === original.component);
        if (!madeForSet.length)
            continue;
        const entry = structuredClone(original);
        let complete = entry.variants.length > 0;
        for (const variant of entry.variants) {
            const made = madeForSet.find(p => p.variant === variant.id);
            if (!made) {
                complete = false;
                continue;
            }
            variant.preview = made.file;
            variant.previewBackground = made.background;
        }
        if (complete)
            delete entry.status;
        writeVariantSet(workspace, {
            operation: "update", component: original.component, entry,
            expectedRevision: revisionOf(original),
        });
    }
}
export function validatePublishedManifest(workspace, assets) {
    const built = JSON.parse(readFileSync(join(assets, 'prototype.json'), 'utf8'));
    validateVariantSets(built, { mode: 'publish', workspace, assets });
    const source = join(workspace, 'public/prototype.json');
    if (existsSync(source))
        check(isDeepStrictEqual(JSON.parse(readFileSync(source, 'utf8')), built), 'prototype.json changed since the build; build again before publishing');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try {
        const [operation, workspace, component, ...args] = process.argv.slice(2);
        check(workspace && component, 'usage: variant-manifest.mjs begin|read|finish|update <workspace> <component> [--title <title>] [--entry <file>] [--expected <revision>]');
        const options = {};
        for (let i = 0; i < args.length; i += 2) {
            check(['--title', '--entry', '--expected', '--requires-component', '--requires-variant'].includes(args[i]) && args[i + 1], `unknown or missing option ${args[i]}`);
            options[args[i].slice(2)] = args[i + 1];
        }
        let result;
        if (operation === 'read')
            result = readVariantSet(workspace, component);
        else if (operation === 'begin') {
            check(options.title?.trim(), '--title is required');
            const entry = { component, title: options.title, status: 'building', variants: [], default: '' };
            if (options['requires-component'] || options['requires-variant']) {
                check(options['requires-component'] && options['requires-variant'], 'pass both --requires-component and --requires-variant');
                entry.requires = { component: options['requires-component'], variant: options['requires-variant'] };
            }
            result = writeVariantSet(workspace, { operation: 'create', component, entry });
        }
        else {
            check(options.entry, '--entry is required');
            result = writeVariantSet(workspace, { operation, component, entry: JSON.parse(readFileSync(options.entry, 'utf8')), expectedRevision: options.expected });
        }
        console.log(JSON.stringify(result, null, 2));
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
