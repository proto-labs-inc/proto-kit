import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readBriefInputs } from './brief-inputs.mjs';

const inputs = { description: 'Change the header', documentUrl: null, referenceUrl: 'https://source.invalid/settings', referenceImage: 'https://images.invalid/page.png', referenceHtml: null, useRealData: false };

test('all saved actions read JSON inputs even when retired columns differ', () => {
  for (const action of ['create-prototype', 'add-variants', 'rebuild-section']) {
    const brief = { action, inputs, description: 'Obsolete', url: 'https://obsolete.invalid', use_real_data: true };
    assert.deepEqual(readBriefInputs(brief), inputs);
  }
});

test('migrated historical requests retain null references for the missing-input workflow', () => {
  const historical = { ...inputs, referenceUrl: null, referenceImage: null };
  assert.deepEqual(readBriefInputs({ inputs: historical }), historical);
});

test('missing or malformed JSON blocks without falling back to retired columns', () => {
  for (const value of [undefined, null, [], {}, { ...inputs, useRealData: 'false' }, { ...inputs, referenceImage: 123 }]) {
    assert.throws(() => readBriefInputs({ inputs: value, description: 'Old', url: inputs.referenceUrl }), /inputs/);
  }
});
