/**
 * The conditional-request / rate-limit scenario's pure parts: header family detection, reset
 * format, and the claims made from a fresh / If-None-Match / stale-tag / If-Modified-Since sequence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conditionalClaims, rateHeaders, resetFormat, type CondObs } from '../../src/worker/scenarios/conditional.js';

const RL = (remaining: number, reset = 1800000000, family = 'x-ratelimit') => ({ [`${family}-limit`]: '1000', [`${family}-remaining`]: String(remaining), [`${family}-reset`]: String(reset) });
const VAL = { etag: '"abc"', 'last-modified': 'Wed, 01 Oct 2026 00:00:00 GMT' };
function o(trialId: number, step: CondObs['step'], status: number, headers: Record<string, string>): CondObs {
  return { trialId, step, status, bodyKind: status === 304 ? 'empty' : 'json', headers };
}
const statuses = (obs: CondObs[]) => new Map(obs.map((x) => [x.trialId, { statusCode: x.status }]));
const keys = (claims: { claim_key: string }[]) => claims.map((c) => c.claim_key.split(':')[1]).sort();

test('rateHeaders and resetFormat: the three header families; epoch seconds vs milliseconds vs delta', () => {
  assert.deepEqual(rateHeaders(RL(42)), { family: 'x-ratelimit', remaining: 42, reset: 1800000000, limit: 1000 });
  assert.deepEqual(rateHeaders({ 'ratelimit-remaining': '9', 'ratelimit-reset': '30' }), { family: 'ratelimit', remaining: 9, reset: 30, limit: null });
  assert.deepEqual(rateHeaders({ 'x-rate-limit-remaining': '5', 'x-rate-limit-limit': '10' }), { family: 'x-rate-limit', remaining: 5, reset: null, limit: 10 });
  assert.equal(rateHeaders({ 'content-type': 'application/json' }), null);
  assert.equal(resetFormat(1800000000), 'epoch seconds');
  assert.equal(resetFormat(1800000000000), 'epoch milliseconds');
  assert.equal(resetFormat(30), 'seconds until reset');
  assert.equal(resetFormat(null), null);
});

test('conditionalClaims: honored ETag, free 304, honored Last-Modified, exact per-request accounting', () => {
  const obs = [o(1, 'fresh', 200, { ...VAL, ...RL(100) }), o(2, 'if_none_match', 304, { ...VAL, ...RL(100) }), o(3, 'stale_tag', 200, { ...VAL, ...RL(99) }), o(4, 'if_modified_since', 304, { ...VAL, ...RL(99) })];
  const claims = conditionalClaims('GET /v1/items', obs, statuses(obs));
  assert.deepEqual(keys(claims), ['conditional_cost', 'conditional_etag', 'conditional_last_modified', 'rate_limit_accounting']);
  const by = Object.fromEntries(claims.map((c) => [c.claim_key.split(':')[1], c]));
  assert.match(by.conditional_etag.statement, /honor If-None-Match: re-requesting with the current tag returns HTTP 304 with an empty body, while a stale tag returns HTTP 200/);
  assert.deepEqual(by.conditional_etag.evidence_trial_ids, [1, 2, 3]);
  assert.match(by.conditional_cost.statement, /does not count against the rate limit: x-ratelimit-remaining was unchanged by the conditional request and dropped by 1 for the full request that followed/);
  assert.match(by.conditional_last_modified.statement, /honor If-Modified-Since/);
  assert.match(by.rate_limit_accounting.statement, /^Each full request decrements x-ratelimit-remaining by exactly 1 with x-ratelimit-reset unchanged \(a fixed window, not a sliding one\)\. x-ratelimit-reset is epoch seconds. The limit is 1000.$/);
  assert.deepEqual(by.rate_limit_accounting.evidence_trial_ids, [2, 3], 'measured over the one full request after the 304');
  for (const c of claims) {
    assert.equal(c.source, 'scenario');
    assert.equal(c.kind, 'undocumented');
    assert.ok(c.expectations.every((e) => e.status === 200 || e.status === 304));
  }
});

test('conditionalClaims: a 304 that costs quota; an ignored ETag; a 304 for any tag; weighted requests', () => {
  const costly = [o(1, 'fresh', 200, { ...VAL, ...RL(100) }), o(2, 'if_none_match', 304, { ...VAL, ...RL(99) }), o(3, 'stale_tag', 200, { ...VAL, ...RL(98) })];
  assert.match(conditionalClaims('GET /x', costly, statuses(costly)).find((c) => /conditional_cost/.test(c.claim_key))!.statement, /still counts against the rate limit/);

  const ignored = [o(1, 'fresh', 200, { ...VAL, ...RL(100) }), o(2, 'if_none_match', 200, { ...VAL, ...RL(99) }), o(3, 'stale_tag', 200, { ...VAL, ...RL(98) })];
  const ig = conditionalClaims('GET /x', ignored, statuses(ignored));
  assert.match(ig.find((c) => /conditional_etag/.test(c.claim_key))!.statement, /If-None-Match is ignored/);
  assert.ok(!ig.some((c) => /conditional_cost/.test(c.claim_key)), 'no 304, nothing to cost');
  assert.match(ig.find((c) => /rate_limit_accounting/.test(c.claim_key))!.statement, /decrements x-ratelimit-remaining by exactly 1/, 'two full requests after fresh, two decrements');

  const anyTag = [o(1, 'fresh', 200, { ...VAL, ...RL(100) }), o(2, 'if_none_match', 304, { ...VAL, ...RL(100) }), o(3, 'stale_tag', 304, { ...VAL, ...RL(100) })];
  assert.match(conditionalClaims('GET /x', anyTag, statuses(anyTag)).find((c) => /conditional_etag/.test(c.claim_key))!.statement, /HTTP 304 for ANY tag/);

  const weighted = [o(1, 'fresh', 200, { ...VAL, ...RL(100) }), o(2, 'if_none_match', 304, { ...VAL, ...RL(100) }), o(3, 'stale_tag', 200, { ...VAL, ...RL(95) })];
  assert.match(conditionalClaims('GET /x', weighted, statuses(weighted)).find((c) => /rate_limit_accounting/.test(c.claim_key))!.statement, /by 5, not 1: requests are weighted/);
});

test('conditionalClaims: no validators at all; no rate-limit headers; a window that rolled over; a failed fresh request', () => {
  const none = [o(1, 'fresh', 200, RL(10)), o(2, 'repeat', 200, RL(9))];
  const n = conditionalClaims('GET /x', none, statuses(none));
  assert.deepEqual(keys(n), ['conditional_none', 'rate_limit_accounting']);
  assert.match(n[0].statement, /neither ETag nor Last-Modified \(HTTP 200\): conditional requests are not possible/);

  const noRate = [o(1, 'fresh', 200, VAL), o(2, 'if_none_match', 304, VAL), o(3, 'stale_tag', 200, VAL)];
  assert.deepEqual(keys(conditionalClaims('GET /x', noRate, statuses(noRate))), ['conditional_etag'], 'without a counter there is nothing to say about cost or accounting');

  const rolled = [o(1, 'fresh', 200, { ...VAL, ...RL(1, 1800000000) }), o(2, 'if_none_match', 304, { ...VAL, ...RL(1000, 1800003600) }), o(3, 'stale_tag', 200, { ...VAL, ...RL(999, 1800003600) })];
  assert.deepEqual(keys(conditionalClaims('GET /x', rolled, statuses(rolled))), ['conditional_etag', 'rate_limit_accounting'], 'the reset changed between fresh and the 304: cost not claimed; accounting measured within the new window');

  const failed = [o(1, 'fresh', 500, {})];
  assert.deepEqual(conditionalClaims('GET /x', failed, statuses(failed)), []);
  // A timed-out conditional request is not an inconsistency; a 304 without rate headers leaves accounting unclaimed.
  const timedOut: CondObs[] = [o(1, 'fresh', 200, { ...VAL, ...RL(10) }), { trialId: 2, step: 'if_none_match', status: null, bodyKind: 'none', headers: {} }, o(3, 'stale_tag', 200, { ...VAL, ...RL(9) })];
  assert.ok(!conditionalClaims('GET /x', timedOut, new Map([[1, { statusCode: 200 }], [2, { statusCode: null }], [3, { statusCode: 200 }]])).some((c) => /conditional_etag/.test(c.claim_key)));
  const no304Headers = [o(1, 'fresh', 200, { ...VAL, ...RL(10) }), o(2, 'if_none_match', 304, VAL), o(3, 'stale_tag', 200, { ...VAL, ...RL(8) })];
  assert.ok(!conditionalClaims('GET /x', no304Headers, statuses(no304Headers)).some((c) => /rate_limit_accounting|conditional_cost/.test(c.claim_key)));
});
