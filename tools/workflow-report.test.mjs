import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workflowEvent, activityEvent } from './workflow-report.mjs';

test('copy and build have separate revisions while checks retain the build revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proto-workflow-'));
  try {
    const copy = workflowEvent(dir, 'copy', 'Copying');
    const retry = workflowEvent(dir, 'copy', 'Retrying copy');
    assert.equal(copy.revision, retry.revision);
    assert.equal(activityEvent(copy, 'capture', 'active', 'Capturing', '').step, 'copy');
    const build = workflowEvent(dir, 'build', 'Applying changes');
    assert.notEqual(build.revision, copy.revision);
    assert.equal(workflowEvent(dir, 'check', 'Checking').revision, build.revision);
    assert.notEqual(workflowEvent(dir, 'build', 'Fixing').revision, build.revision);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
