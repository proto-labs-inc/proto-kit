import test from 'node:test';
import assert from 'node:assert/strict';
import {validateVerification} from './screen-verification.mjs';
const screen = {
 source_url: 'https://example.test/screen', bundle_checksum: 'a'.repeat(64),
 metadata: {
  preparedBuild: {sourceChecksum:'a'.repeat(64),checksum:'b'.repeat(64)},
  staffAcceptance: {kind:'staff-accepted',acceptedBy:'Staff',acceptedAt:'2026-10-12T12:00:00.000Z',reason:'Explicit release',sourceUrl:'https://example.test/screen',sourceChecksum:'a'.repeat(64),buildChecksum:'b'.repeat(64)},
 },
};
test('staff acceptance permits exact artifacts without claiming verification passed',()=>{
 assert.equal(validateVerification(undefined,screen).kind,'staff-accepted');
 assert.equal(screen.metadata.verification,undefined);
 for (const change of [
  s=>{s.bundle_checksum='c'.repeat(64)},
  s=>{s.metadata.preparedBuild.checksum='c'.repeat(64)},
  s=>{s.metadata.preparedBuild.sourceChecksum='c'.repeat(64)},
  s=>{s.source_url='https://example.test/other'},
  s=>{s.metadata.staffAcceptance.reason=''},
  s=>{delete s.metadata.staffAcceptance},
 ]) {
  const changed=structuredClone(screen); change(changed);
  assert.throws(()=>validateVerification(undefined,changed));
 }
});
