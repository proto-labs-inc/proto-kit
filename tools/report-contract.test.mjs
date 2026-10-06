import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport } from './report-contract.mjs';
test('report validation rejects malformed activity details and visual metrics before queueing',()=>{
  const activity={kind:'activity',reportId:'r',revision:'v',step:'check',id:'checks',status:'active',title:'Checking',detail:''};
  assert.equal(validateReport(activity),activity);assert.throws(()=>validateReport({...activity,detail:undefined}),/detail/);
  assert.throws(()=>validateReport({...activity,title:'x'.repeat(121)}),/title/);
  assert.throws(()=>validateReport({kind:'pass',id:'header',pass:1,mismatch:-1}),/mismatch/);
  assert.throws(()=>validateReport({kind:'reference',image:'not a url',width:80,height:120}),/image/);
  assert.throws(()=>validateReport({kind:'answered',questionId:'q-test',by:'default',option:'build'}),/explicit/);
});
