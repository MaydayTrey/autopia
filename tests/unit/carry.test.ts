import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryForwardLlmClaims } from '../../src/worker/aggregate/carry.js';
import { OK_LIST, fakeClaim, fakeTrial, resetIds } from '../helpers.js';

test('carryForwardLlmClaims remaps evidence by endpoint+probe, keeps statuses, skips rules claims', () => {
  resetIds(1);
  const prevBaseline = fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST });
  const prevHead = fakeTrial({ mutationId: 'method_head', status: 200, method: 'HEAD' });
  const prevTrials = new Map([prevBaseline, prevHead].map((t) => [t.id, t]));
  resetIds(100);
  const nowBaseline = fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST });
  const nowHead = fakeTrial({ mutationId: 'method_head', status: 404, method: 'HEAD' }); // behavior changed tonight
  const trials = [nowBaseline, nowHead];

  const llm = { ...fakeClaim({ claimKey: 'llm:undocumented:get_v1_items:-:observes:baseline+method_head', verdict: 'observes', statuses: [200, 200] }), source: 'llm', kind: 'undocumented', statement: 'HEAD mirrors GET.' };
  llm.evidenceTrialIds = [prevBaseline.id, prevHead.id];
  llm.expectations = [{ trial_id: prevBaseline.id, status: 200 }, { trial_id: prevHead.id, status: 200 }];
  const rules = { ...fakeClaim({ claimKey: 'rule:baseline:get_v1_items:-' }), source: 'rules' };

  const r = carryForwardLlmClaims([rules, llm], prevTrials, trials);
  assert.equal(r.claims.length, 1, 'only the LLM claim is carried');
  const c = r.claims[0];
  assert.equal(c.claim_key, llm.claimKey);
  assert.equal(c.source, 'llm');
  assert.deepEqual(c.evidence_trial_ids, [nowBaseline.id, nowHead.id]);
  // expected statuses are the OLD ones: the evidence check will now fail on method_head (404 != 200) and drop it. Correct.
  assert.deepEqual(c.expectations, [{ trial_id: nowBaseline.id, status: 200 }, { trial_id: nowHead.id, status: 200 }]);
  assert.equal(r.dropped.length, 0);
});

test('carryForwardLlmClaims drops claims whose probe is missing tonight or whose old trial is gone', () => {
  resetIds(1);
  const prevA = fakeTrial({ mutationId: 'extra_field', status: 200, body: OK_LIST });
  const prevTrials = new Map([[prevA.id, prevA]]);
  resetIds(50);
  const trials = [fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST })]; // no extra_field tonight
  const missingProbe = { ...fakeClaim({ claimKey: 'k1' }), source: 'llm', evidenceTrialIds: [prevA.id], expectations: [{ trial_id: prevA.id, status: 200 }] };
  const missingTrial = { ...fakeClaim({ claimKey: 'k2' }), source: 'llm', evidenceTrialIds: [999], expectations: [{ trial_id: 999, status: 200 }] };
  const r = carryForwardLlmClaims([missingProbe, missingTrial], prevTrials, trials);
  assert.equal(r.claims.length, 0);
  assert.deepEqual(r.dropped.map((d) => d.claim_key), ['k1', 'k2']);
  assert.match(r.dropped[0].reason, /probe extra_field not in this run/);
  assert.match(r.dropped[1].reason, /no longer exists/);
});
