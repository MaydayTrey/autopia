import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesClaims } from '../../src/worker/aggregate/rules.js';
import { ERR, OK_LIST, fakeTrial, itemsEndpoint, resetIds } from '../helpers.js';

function v1Trials() {
  resetIds();
  const q: [string, string][] = [['q', 'hello']];
  return [
    fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }),
    fakeTrial({ mutationId: 'required_omitted:q', status: 200, body: OK_LIST, query: [] }), // planted divergence
    fakeTrial({ mutationId: 'optional_present:limit', status: 200, body: OK_LIST, query: [...q, ['limit', '1']] }),
    fakeTrial({ mutationId: 'optional_present:sort', status: 200, body: OK_LIST, query: [...q, ['sort', 'asc']] }),
    fakeTrial({ mutationId: 'optional_present:page', status: 200, body: OK_LIST, query: [...q, ['page', '1']] }),
    fakeTrial({ mutationId: 'wrong_type:limit', status: 200, body: OK_LIST, query: [...q, ['limit', 'abc']] }), // planted divergence
    fakeTrial({ mutationId: 'boundary_above_max:limit', status: 200, body: OK_LIST, query: [...q, ['limit', '101']] }), // planted divergence
    fakeTrial({ mutationId: 'boundary_below_min:limit', status: 400, body: ERR('invalid_limit', 'limit must be >= 1'), query: [...q, ['limit', '0']] }),
    fakeTrial({ mutationId: 'enum_invalid:sort', status: 400, body: ERR('invalid_sort', 'sort must be asc or desc'), query: [...q, ['sort', 'zzz']] }),
    fakeTrial({ mutationId: 'empty_value:limit', status: 200, body: OK_LIST, query: [...q, ['limit', '']] }),
    fakeTrial({ mutationId: 'null_value:q', status: 400, body: ERR('invalid_q', 'q may not be null'), query: [['q', 'null']] }),
    fakeTrial({ mutationId: 'pagination_zero:page', status: 400, body: ERR('invalid_page', 'page must be >= 1'), query: [...q, ['page', '0']] }),
    fakeTrial({ mutationId: 'extra_field', status: 200, body: OK_LIST, query: [...q, ['autopia_unknown_param', '1']] }),
    fakeTrial({ mutationId: 'bad_auth', status: 200, body: OK_LIST, query: [...q, ['api_key', 'invalid']] }),
    fakeTrial({ mutationId: 'path_trailing_slash', status: 404, body: 'not found', query: q, url: 'http://x/v1/items/' }),
    fakeTrial({ mutationId: 'method_head', status: 200, query: q, method: 'HEAD' }),
    fakeTrial({ mutationId: 'wrong_content_type', status: 200, body: OK_LIST, query: q, headers: { accept: 'application/xml' } }),
  ];
}

test('rules: planted divergences become claims with diverges_from_spec=true and full evidence', () => {
  const claims = rulesClaims(v1Trials(), [itemsEndpoint]);
  const byKey = Object.fromEntries(claims.map((c) => [c.claim_key, c]));

  const req = byKey['rule:required_omitted:get_v1_items:q'];
  assert.ok(req, 'required_omitted claim exists');
  assert.equal(req.kind, 'required');
  assert.equal(req.verdict, 'accepts');
  assert.equal(req.diverges_from_spec, true);
  assert.deepEqual(req.evidence_trial_ids, [1, 2]);
  assert.deepEqual(req.expectations, [{ trial_id: 1, status: 200 }, { trial_id: 2, status: 200 }]);

  const wt = byKey['rule:wrong_type:get_v1_items:limit'];
  assert.equal(wt.verdict, 'accepts');
  assert.equal(wt.diverges_from_spec, true);
  assert.deepEqual(wt.evidence_trial_ids, [3, 6]); // compared against optional_present:limit, not baseline

  const above = byKey['rule:boundary_above_max:get_v1_items:limit'];
  assert.equal(above.diverges_from_spec, true);
  assert.match(above.statement, /maximum 100/);

  const below = byKey['rule:boundary_below_min:get_v1_items:limit'];
  assert.equal(below.verdict, 'rejects');
  assert.equal(below.diverges_from_spec, false);
  assert.match(below.statement, /limit must be >= 1/);

  const en = byKey['rule:enum_invalid:get_v1_items:sort'];
  assert.equal(en.verdict, 'rejects');
  assert.equal(en.diverges_from_spec, false);

  assert.equal(byKey['rule:extra_field:get_v1_items:-'].verdict, 'accepts');
  assert.equal(byKey['rule:bad_auth:get_v1_items:-'].kind, 'auth');
  assert.equal(byKey['rule:bad_auth:get_v1_items:-'].verdict, 'accepts');
  assert.equal(byKey['rule:pagination_zero:get_v1_items:page'].kind, 'pagination');
  assert.equal(byKey['rule:empty_value:get_v1_items:limit'].verdict, 'accepts');
  assert.match(byKey['rule:empty_value:get_v1_items:limit'].statement, /same shape/);
  assert.equal(byKey['rule:null_value:get_v1_items:q'].verdict, 'rejects');
  assert.match(byKey['rule:path_trailing_slash:get_v1_items:-'].statement, /HTTP 404/);
  assert.match(byKey['rule:method_head:get_v1_items:-'].statement, /HTTP 200/);

  const err = byKey['rule:error_shape:get_v1_items:-'];
  assert.ok(err, 'error_behavior claim exists');
  assert.equal(err.kind, 'error_behavior');
  assert.match(err.statement, /HTTP 400/);
  assert.match(err.statement, /"error":\{"code":"string","message":"string"\}/);
  assert.ok(err.evidence_trial_ids.length >= 3);

  for (const c of claims) {
    assert.equal(c.source, 'rules');
    assert.ok(c.evidence_trial_ids.length >= 1, `${c.claim_key} has evidence`);
    assert.equal(c.expectations.length, c.evidence_trial_ids.length);
    assert.ok(c.confidence > 0 && c.confidence <= 1);
  }
});

test('rules: failing baseline suppresses downstream claims', () => {
  resetIds();
  const trials = [fakeTrial({ mutationId: 'baseline', status: 500, body: ERR('boom', 'server error') }), fakeTrial({ mutationId: 'required_omitted:q', status: 200, body: OK_LIST })];
  const claims = rulesClaims(trials, [itemsEndpoint]);
  assert.equal(claims.length, 1);
  assert.match(claims[0].statement, /does not succeed/);
});

test('rules: rate-limited and no-response trials are ignored', () => {
  resetIds();
  const trials = [
    fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST }),
    fakeTrial({ mutationId: 'required_omitted:q', status: 429, body: ERR('rl', 'slow'), errorText: 'rate_limited' }),
    fakeTrial({ mutationId: 'extra_field', status: null }),
  ];
  const keys = rulesClaims(trials, [itemsEndpoint]).map((c) => c.claim_key);
  assert.deepEqual(keys, ['rule:baseline:get_v1_items:-']);
});

test('rules: two runs over equivalent trials give identical claim keys', () => {
  const a = rulesClaims(v1Trials(), [itemsEndpoint]).map((c) => c.claim_key);
  const b = rulesClaims(v1Trials(), [itemsEndpoint]).map((c) => c.claim_key);
  assert.deepEqual(a, b);
});
