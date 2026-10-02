import { existsSync, readdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';

export const retryFingerprint = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');

// Only an explicitly matched outcome with every recorded output still present
// is reusable. A missing/old checkpoint conservatively retries everything.
export function selectRetryParts(parts, saved, fileExists = existsSync) {
  const prior = new Map((saved?.version === 1 && Array.isArray(saved.parts) ? saved.parts : []).filter(part => part && typeof part === 'object').map(part => [part.id, part]));
  const retained = [], selected = [];
  for (const part of parts) {
    const old = prior.get(part.id);
    if (old?.slug === part.slug && typeof part.retryFingerprint === 'string' && old.retryFingerprint === part.retryFingerprint && old.outcome?.matched === true &&
        Array.isArray(old.artifacts) && old.artifacts.length > 0 && old.artifacts.every(file => typeof file === 'string' && file.length > 0 && !isAbsolute(file) && !file.split(/[\\/]/).includes('..') && fileExists(join(part.folder, file)))) {
      part.outcome = old.outcome;
      part.reused = old.reused ?? null;
      part.retained = true;
      retained.push(part);
    } else selected.push(part);
  }
  return { retained, selected };
}

export function artifactFiles(folder, prefix = '') {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? artifactFiles(join(folder, entry.name), relative) : [relative];
  });
}
