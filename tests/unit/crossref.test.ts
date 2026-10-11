import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateClaim } from '../../src/worker/claims.js';
import { crossReference, tagAgainstSpec } from '../../src/worker/crossref.js';
import { itemsEndpoint } from '../helpers.js';

function c(p: Partial<CandidateClaim> & { claim_key: string }): CandidateClaim {
  const ev = p.evidence_trial_ids ?? [1, 2];
  return {
    statement: `s ${p.claim_key}`,
    endpoint: 'GET /v1/items',
    kind: 'type',
    param: 'limit',
    verdict: 'observes',
    source: 'rules',
    confidence: 0.9,
    evidence_trial_ids: ev,
    expectations: ev.map((id) => ({ trial_id: id, status: 200 })),
    diverges_from_spec: false,
    spec_says: null,
    ...p,
  };
}

test('crossref: duplicate claim_key keeps the first', () => {
  const r = crossReference([c({ claim_key: 'k', source: 'rules' }), c({ claim_key: 'k', source: 'llm' })], [itemsEndpoint]);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].source, 'rules');
  assert.equal(r.quarantined.length, 1);
  assert.match(r.quarantined[0].reason, /duplicate/);
});

test('crossref: same trial with different expected statuses -> both quarantined', () => {
  const a = c({ claim_key: 'a', expectations: [{ trial_id: 1, status: 200 }], evidence_trial_ids: [1] });
  const b = c({ claim_key: 'b', expectations: [{ trial_id: 1, status: 400 }], evidence_trial_ids: [1] });
  const r = crossReference([a, b], [itemsEndpoint]);
  assert.equal(r.kept.length, 0);
  assert.equal(r.quarantined.length, 2);
  assert.match(r.quarantined[0].reason, /contradiction: trial 1/);
});

test('crossref: accepts vs rejects over IDENTICAL evidence -> quarantined', () => {
  const a = c({ claim_key: 'a', verdict: 'accepts', evidence_trial_ids: [1, 5] });
  const b = c({ claim_key: 'b', verdict: 'rejects', evidence_trial_ids: [5, 1], expectations: [{ trial_id: 1, status: 200 }, { trial_id: 5, status: 200 }] });
  const r = crossReference([a, b], [itemsEndpoint]);
  assert.equal(r.kept.length, 0);
  assert.match(r.quarantined[0].reason, /identical evidence/);
});

test('crossref: different probes sharing only the baseline are NOT contradictions', () => {
  // empty value accepted (trials 3,7) vs literal null rejected (trials 3,8): both cite base trial 3
  const a = c({ claim_key: 'a', verdict: 'accepts', evidence_trial_ids: [3, 7], expectations: [{ trial_id: 3, status: 200 }, { trial_id: 7, status: 200 }] });
  const b = c({ claim_key: 'b', verdict: 'rejects', evidence_trial_ids: [3, 8], expectations: [{ trial_id: 3, status: 200 }, { trial_id: 8, status: 400 }] });
  const r = crossReference([a, b], [itemsEndpoint]);
  assert.equal(r.kept.length, 2);
  assert.equal(r.quarantined.length, 0);
});

test('tagAgainstSpec: required-param claims are tagged mechanically', () => {
  const params = new Map(itemsEndpoint.params.map((p) => [p.name, p]));
  const llm = c({ claim_key: 'x', source: 'llm', kind: 'required', param: 'q', verdict: 'accepts', diverges_from_spec: false });
  assert.equal(tagAgainstSpec(llm, params).diverges_from_spec, true);
  const agrees = c({ claim_key: 'y', source: 'llm', kind: 'required', param: 'q', verdict: 'rejects', diverges_from_spec: true });
  assert.equal(tagAgainstSpec(agrees, params).diverges_from_spec, false);
  const optionalRejected = c({ claim_key: 'z', source: 'llm', kind: 'required', param: 'limit', verdict: 'rejects' });
  assert.equal(tagAgainstSpec(optionalRejected, params).diverges_from_spec, true);
  const unknownParam = c({ claim_key: 'w', source: 'llm', kind: 'undocumented', param: 'nope', verdict: 'observes', diverges_from_spec: true });
  assert.equal(tagAgainstSpec(unknownParam, params).diverges_from_spec, true); // LLM flag kept where spec is silent
});
