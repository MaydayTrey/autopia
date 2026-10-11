import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryForwardLlmClaims, dropSupersededCarried } from '../../src/worker/aggregate/carry.js';
import type { CandidateClaim } from '../../src/worker/claims.js';
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


test('dropSupersededCarried drops a carried LLM claim when a fresh one on the same endpoint cites the same probes (baseline ignored; kind/param/verdict may differ) and dedupes carried-vs-carried', () => {
  resetIds(100);
  const baseline = fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST });
  const nullBefore = fakeTrial({ mutationId: 'null_value:before_id', status: 400, body: { error: 'not found' } });
  const nullAfter = fakeTrial({ mutationId: 'null_value:after_id', status: 400, body: { error: 'not found' } });
  const presentBefore = fakeTrial({ mutationId: 'optional_present:before_id', status: 200, body: OK_LIST });
  const extra = fakeTrial({ mutationId: 'extra_field', status: 200, body: OK_LIST });
  const trialsById = new Map([baseline, nullBefore, nullAfter, presentBefore, extra].map((t) => [t.id, t]));
  const cand = (p: { key: string; kind: string; param: string | null; verdict: 'accepts' | 'rejects' | 'observes'; ids: number[]; endpoint?: string }): CandidateClaim => ({
    claim_key: p.key,
    statement: p.key,
    endpoint: p.endpoint ?? 'GET /v1/models',
    kind: p.kind as CandidateClaim['kind'],
    param: p.param,
    verdict: p.verdict,
    source: 'llm',
    confidence: 0.8,
    evidence_trial_ids: p.ids,
    expectations: p.ids.map((id) => ({ trial_id: id, status: trialsById.get(id)!.statusCode })),
    diverges_from_spec: false,
    spec_says: null,
  });

  // anthropic-api run #44: the carried claim named after_id and cited no baseline; the fresh one named before_id and added the baseline.
  const carriedCursor = cand({ key: 'llm:undocumented_constraint:get_v1_models:after_id:rejects:null_value:after_id+null_value:before_id', kind: 'undocumented_constraint', param: 'after_id', verdict: 'rejects', ids: [nullAfter.id, nullBefore.id] });
  const freshCursor = cand({ key: 'llm:undocumented_constraint:get_v1_models:before_id:rejects:baseline+null_value:after_id+null_value:before_id', kind: 'undocumented_constraint', param: 'before_id', verdict: 'rejects', ids: [baseline.id, nullAfter.id, nullBefore.id] });
  // Same probes, different KIND (pypi run #46 filed the empty-project finding as error_behavior AND undocumented): superseded too.
  const carriedOtherKind = cand({ key: 'llm:error_behavior:get_v1_models:-:observes:null_value:after_id+null_value:before_id', kind: 'error_behavior', param: null, verdict: 'observes', ids: [nullAfter.id, nullBefore.id] });
  // Two CARRIED claims citing the same probes (anthropic-api: 'unknown model id' filed as observes and as rejects): the more confident one stays.
  const carriedTwinLow = { ...cand({ key: 'llm:error_behavior:get_v1_models:-:observes:extra_field+optional_present:before_id', kind: 'error_behavior', param: null, verdict: 'observes', ids: [extra.id, presentBefore.id] }), confidence: 0.7 };
  const carriedTwinHigh = { ...cand({ key: 'llm:error_behavior:get_v1_models:before_id:rejects:extra_field+optional_present:before_id', kind: 'error_behavior', param: 'before_id', verdict: 'rejects', ids: [baseline.id, extra.id, presentBefore.id] }), confidence: 0.8 };
  // Baseline-only claims keep their kind in the key: a response_shape and an undocumented note on the same endpoint are different findings.
  const carriedShape = cand({ key: 'llm:response_shape:get_v1_models:-:observes:baseline', kind: 'response_shape', param: null, verdict: 'observes', ids: [baseline.id] });
  const carriedBaselineNote = cand({ key: 'llm:undocumented:get_v1_models:-:observes:baseline', kind: 'undocumented', param: null, verdict: 'observes', ids: [baseline.id] });
  // Same probes and kind on a DIFFERENT endpoint: kept.
  const carriedOtherEndpoint = cand({ key: 'llm:undocumented_constraint:get_v1_other:-:rejects:null_value:after_id+null_value:before_id', kind: 'undocumented_constraint', param: null, verdict: 'rejects', ids: [nullAfter.id, nullBefore.id], endpoint: 'GET /v1/other' });
  // Identical key to a fresh claim: left alone here (crossref's exact-key dedupe already keeps the fresh one).
  const carriedSameKey = cand({ key: 'llm:pagination:get_v1_models:before_id:accepts:baseline+optional_present:before_id', kind: 'pagination', param: 'before_id', verdict: 'accepts', ids: [baseline.id, presentBefore.id] });
  const freshSameKey = { ...carriedSameKey };
  // Nothing fresh cites extra_field: kept.
  const carriedUnmatched = cand({ key: 'llm:undocumented:get_v1_models:-:observes:extra_field', kind: 'undocumented', param: null, verdict: 'observes', ids: [extra.id] });

  const r = dropSupersededCarried(
    { claims: [carriedCursor, carriedOtherKind, carriedOtherEndpoint, carriedSameKey, carriedUnmatched, carriedTwinLow, carriedTwinHigh, carriedShape, carriedBaselineNote], dropped: [{ claim_key: 'earlier', reason: 'probe x not in this run' }] },
    [freshCursor, freshSameKey],
    trialsById,
  );
  assert.deepEqual(
    r.claims.map((c) => c.claim_key),
    [carriedOtherEndpoint.claim_key, carriedSameKey.claim_key, carriedUnmatched.claim_key, carriedTwinHigh.claim_key, carriedShape.claim_key, carriedBaselineNote.claim_key],
    'kept, in the original carried order',
  );
  assert.equal(r.dropped[0].claim_key, 'earlier', 'earlier drops are preserved');
  const dropped = Object.fromEntries(r.dropped.slice(1).map((d) => [d.claim_key, d.reason]));
  assert.match(dropped[carriedCursor.claim_key], /superseded by fresh LLM claim llm:undocumented_constraint:get_v1_models:before_id/);
  assert.match(dropped[carriedOtherKind.claim_key], /superseded by fresh LLM claim/);
  assert.match(dropped[carriedTwinLow.claim_key], /duplicate of carried claim llm:error_behavior:get_v1_models:before_id:rejects/);
  assert.equal(Object.keys(dropped).length, 3);
});
