#!/usr/bin/env node
// Offline only. Invoked by the Proto update skill.
const fs = require('node:fs');
const path = require('node:path');
const [root, required] = process.argv.slice(2);
const valid = value => /^0\.1\.0\+codex\.\d{14}$/.test(value || '');
let result = { status: 'update_needed', reason: 'missing_or_unreadable_plugin' };
try {
  if (!root || root === "MISSING") throw new Error("No installed root");
  const installedRoot = path.resolve(root);
  const { version } = JSON.parse(fs.readFileSync(path.join(installedRoot, '.codex-plugin/plugin.json'), 'utf8'));
  const provenance = JSON.parse(fs.readFileSync(path.join(installedRoot, '.proto-release.json'), 'utf8'));
  result = { status: 'update_needed', reason: 'unknown_required_version', installedRoot, version };
  if (valid(required) && valid(version)) {
    const current = version >= required && provenance.version === version;
    result = { ...result, status: current ? 'current' : 'update_needed', reason: current ? 'meets_prompt_version' : 'older_or_unverified_release' };
  }
} catch { /* Missing, old or malformed installations need the online updater. */ }
console.log(JSON.stringify(result));
