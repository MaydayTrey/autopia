import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siblingKey, type CandidateClaim } from '../../src/worker/claims.js';
import { crossReference, tagAgainstSiblings, type SiblingIndex } from '../../src/worker/crossref.js';
import { itemsEndpoint } from '../helpers.js';

function c(p: Partial<CandidateClaim> & { claim_key: string }): CandidateClaim {
  const ev = p.evidence_trial_ids ?? [1, 2];
  return {
    statement: `s ${p.claim_key}`,
    endpoint: 'GET /v1/items',
    kind: 'undocumented',
    param: null,
    verdict: 'accepts',
    source: 'rules',
    confidence: 0.9,
    evidence_trial_ids: ev,
    expectations: ev.map((id) => ({ trial_id: id, status: 200 })),
    diverges_from_spec: false,
    spec_says: null,
    ...p,
  };
}

test('siblingKey drops the endpoint from rules keys and ignores LLM keys', () => {
  assert.equal(siblingKey('rule:extra_field:get_v1_forecast:-', 'rules'), 'rule:extra_field:-');
  assert.equal(siblingKey('rule:wrong_type:get_v1_air_quality:past_days', 'rules'), 'rule:wrong_type:past_days');
  assert.equal(siblingKey('rule:extra_field:get_v1_items:-', 'llm'), null);
  assert.equal(siblingKey('llm:other:get_v1_items:-:observes:baseline', 'llm'), null);
  assert.equal(siblingKey('garbage', 'rules'), null);
});

test('tagAgainstSiblings flags opposite verdicts on the same probe, ignores agreement and observes', () => {
  const siblings: SiblingIndex = new Map([
    // forecast appears twice (two endpoints); the note must list it once
    ['rule:extra_field:-', [{ tool: 'forecast', verdict: 'rejects', statement: 'x' }, { tool: 'forecast', verdict: 'rejects', statement: 'x2' }, { tool: 'marine', verdict: 'accepts', statement: 'y' }]],
    ['rule:bad_auth:-', [{ tool: 'forecast', verdict: 'accepts', statement: 'z' }]],
    ['rule:method_head:-', [{ tool: 'forecast', verdict: 'observes', statement: 'w' }]],
  ]);
  const extra = tagAgainstSiblings(c({ claim_key: 'rule:extra_field:get_v1_items:-', verdict: 'accepts' }), siblings);
  assert.equal(extra.diverges_from_sibling, true);
  assert.equal(extra.sibling_note, 'forecast: rejects'); // marine agrees, so it is not listed
  const auth = tagAgainstSiblings(c({ claim_key: 'rule:bad_auth:get_v1_items:-', verdict: 'accepts' }), siblings);
  assert.equal(auth.diverges_from_sibling, undefined);
  const head = tagAgainstSiblings(c({ claim_key: 'rule:method_head:get_v1_items:-', verdict: 'observes' }), siblings);
  assert.equal(head.diverges_from_sibling, undefined);
  const noSibling = tagAgainstSiblings(c({ claim_key: 'rule:duplicate_param:get_v1_items:q', verdict: 'rejects' }), siblings);
  assert.equal(noSibling.diverges_from_sibling, undefined);
});

test('crossReference applies sibling tagging and counts it separately from spec divergence', () => {
  const siblings: SiblingIndex = new Map([['rule:extra_field:-', [{ tool: 'forecast', verdict: 'rejects', statement: 'x' }]]]);
  const r = crossReference([c({ claim_key: 'rule:extra_field:get_v1_items:-', verdict: 'accepts' }), c({ claim_key: 'rule:baseline:get_v1_items:-', verdict: 'observes', evidence_trial_ids: [1] })], [itemsEndpoint], siblings);
  assert.equal(r.kept.length, 2);
  const tagged = r.kept.find((k) => k.claim_key.startsWith('rule:extra_field'))!;
  assert.equal(tagged.diverges_from_sibling, true);
  assert.equal(tagged.diverges_from_spec, false);
});
