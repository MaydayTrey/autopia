import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeBodyShape, rulesClaims } from '../../src/worker/aggregate/rules.js';
import { signatureOf } from '../../src/worker/signature.js';
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
    fakeTrial({ mutationId: 'bad_auth:api_key', status: 200, body: OK_LIST, query: [...q, ['api_key', 'invalid']] }),
    fakeTrial({ mutationId: 'no_auth:User-Agent', status: 403, body: ERR('forbidden', 'User-Agent required'), query: q, headers: { 'user-agent': '' } }),
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
  assert.equal(byKey['rule:bad_auth:get_v1_items:api_key'].kind, 'auth');
  assert.equal(byKey['rule:bad_auth:get_v1_items:api_key'].verdict, 'accepts');
  assert.match(byKey['rule:bad_auth:get_v1_items:api_key'].statement, /in "api_key"/);
  assert.equal(byKey['rule:no_auth:get_v1_items:User-Agent'].kind, 'auth');
  assert.equal(byKey['rule:no_auth:get_v1_items:User-Agent'].verdict, 'rejects');
  assert.match(byKey['rule:no_auth:get_v1_items:User-Agent'].statement, /HTTP 403/);
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
  const keys = rulesClaims(trials, [itemsEndpoint]).map((c) => c.claim_key).filter((k) => !k.includes(':shape_'));
  assert.deepEqual(keys, ['rule:baseline:get_v1_items:-']);
});

test('rules: two runs over equivalent trials give identical claim keys', () => {
  const a = rulesClaims(v1Trials(), [itemsEndpoint]).map((c) => c.claim_key);
  const b = rulesClaims(v1Trials(), [itemsEndpoint]).map((c) => c.claim_key);
  assert.deepEqual(a, b);
});

test('rules: path-parameter probes produce claims with the substituted value', () => {
  resetIds();
  const ep = { ...itemsEndpoint, path: '/v1/items/{id}', params: [{ name: 'id', in: 'path' as const, required: true, type: 'integer' as const, minimum: 1, explode: true }] };
  const trials = [
    fakeTrial({ mutationId: 'baseline', status: 200, body: { id: 1 }, endpoint: 'GET /v1/items/{id}', url: 'http://x/v1/items/1' }),
    fakeTrial({ mutationId: 'wrong_type:id', status: 400, body: ERR('invalid_id', 'id must be an integer'), endpoint: 'GET /v1/items/{id}', url: 'http://x/v1/items/abc' }),
    fakeTrial({ mutationId: 'boundary_below_min:id', status: 404, body: ERR('not_found', 'no such item'), endpoint: 'GET /v1/items/{id}', url: 'http://x/v1/items/0' }),
  ].map((t) => ({ ...t, input: { ...(t.input as object), pathParams: { id: t.mutationId === 'baseline' ? '1' : t.mutationId.startsWith('wrong') ? 'abc' : '0' } } }));
  const byKey = Object.fromEntries(rulesClaims(trials, [ep]).map((c) => [c.claim_key, c]));
  assert.equal(byKey['rule:wrong_type:get_v1_items_id:id'].verdict, 'rejects');
  assert.match(byKey['rule:wrong_type:get_v1_items_id:id'].statement, /"abc"/);
  assert.equal(byKey['rule:boundary_below_min:get_v1_items_id:id'].verdict, 'rejects');
  assert.match(byKey['rule:boundary_below_min:get_v1_items_id:id'].statement, /"0"/);
  assert.equal(byKey['rule:boundary_below_min:get_v1_items_id:id'].diverges_from_spec, false);
});


test('rules: error_shape counts only bad-VALUE probes; auth, HEAD, XML and trailing-slash rejections are not validation errors', () => {
  resetIds();
  const q: [string, string][] = [['q', 'hello']];
  const trials = [
    fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }),
    fakeTrial({ mutationId: 'wrong_type:limit', status: 400, body: ERR('invalid_limit', 'limit must be an integer'), query: [...q, ['limit', 'abc']] }),
    fakeTrial({ mutationId: 'boundary_below_min:limit', status: 400, body: ERR('invalid_limit', 'limit must be >= 1'), query: [...q, ['limit', '0']] }),
    fakeTrial({ mutationId: 'enum_invalid:sort', status: 400, body: ERR('invalid_sort', 'sort must be asc or desc'), query: [...q, ['sort', 'zzz']] }),
    // Five rejections that are NOT validation errors, each with its own status/shape. Counted, they made
    // anthropic-api /v1/models/{model_id} and npm dist-tags look like they had several error shapes.
    fakeTrial({ mutationId: 'no_auth:User-Agent', status: 403, body: { message: 'forbidden' }, query: q, headers: { 'user-agent': '' } }),
    fakeTrial({ mutationId: 'bad_auth:api_key', status: 401, body: 'unauthorized', query: [...q, ['api_key', 'invalid-key-autopia']] }),
    fakeTrial({ mutationId: 'method_head', status: 405, query: q, method: 'HEAD' }),
    fakeTrial({ mutationId: 'wrong_content_type', status: 406, body: 'not acceptable', query: q, headers: { accept: 'application/xml' } }),
    fakeTrial({ mutationId: 'path_trailing_slash', status: 404, body: 'not found', query: q, url: 'http://x/v1/items/' }),
  ];
  const byKey = Object.fromEntries(rulesClaims(trials, [itemsEndpoint]).map((c) => [c.claim_key, c]));
  const err = byKey['rule:error_shape:get_v1_items:-'];
  assert.ok(err);
  assert.match(err.statement, /consistently return HTTP 400 with a body of shape/);
  assert.match(err.statement, /\(3 of 3 rejected probes\)/);
});

test('rules: error bodies that are bare JSON strings are described as such, not as shape "string"', () => {
  resetIds();
  const q: [string, string][] = [['q', 'hello']];
  // npm's /{package}/{version} answers rejections with a JSON-encoded string: "version not found: abc".
  const jsonString = (mutationId: string, query: [string, string][], text: string) => {
    const t = fakeTrial({ mutationId, status: 404, body: text, query });
    const signature = signatureOf({ status: 404, bodyKind: 'json', body: text, transportError: null });
    return { ...t, response: { ...(t.response as object), body: text, bodyKind: 'json' }, signature: signature as unknown as object };
  };
  const trials = [
    fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }),
    jsonString('wrong_type:limit', [...q, ['limit', 'abc']], 'version not found: abc'),
    jsonString('null_value:limit', [...q, ['limit', 'null']], 'version not found: null'),
    jsonString('boundary_long_string:limit', [...q, ['limit', 'x'.repeat(2048)]], 'version not found: xxx'),
  ];
  const byKey = Object.fromEntries(rulesClaims(trials, [itemsEndpoint]).map((c) => [c.claim_key, c]));
  assert.match(byKey['rule:error_shape:get_v1_items:-'].statement, /HTTP 404 with a bare JSON string body \(3 of 3 rejected probes\)/);
  assert.equal(describeBodyShape('text'), 'a plain-text body');
  assert.equal(describeBodyShape('empty'), 'an empty body');
  assert.equal(describeBodyShape({ error: 'string' }), 'a body of shape {"error":"string"}');
});

test('rules: a trailing slash that changes nothing is reported as tolerated, not as "returns HTTP 200 (without it: HTTP 200)"', () => {
  resetIds();
  const q: [string, string][] = [['q', 'hello']];
  const same = rulesClaims(
    [fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }), fakeTrial({ mutationId: 'path_trailing_slash', status: 200, body: OK_LIST, query: q, url: 'http://x/v1/items/' })],
    [itemsEndpoint],
  ).find((c) => c.claim_key === 'rule:path_trailing_slash:get_v1_items:-')!;
  assert.match(same.statement, /^A trailing slash on the path is tolerated: the response is HTTP 200 either way/);
  resetIds();
  const differs = rulesClaims(
    [fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }), fakeTrial({ mutationId: 'path_trailing_slash', status: 301, body: 'moved', query: q, url: 'http://x/v1/items/' })],
    [itemsEndpoint],
  ).find((c) => c.claim_key === 'rule:path_trailing_slash:get_v1_items:-')!;
  assert.match(differs.statement, /^The path with a trailing slash returns HTTP 301/);
});

test('rules: a page-size cap is claimed only when more items provably exist (Link next, a total field, or the documented maximum reached)', () => {
  const q: [string, string][] = [['q', 'hello']];
  const huge = (extra: { arrayLengths: Record<string, number>; headers?: Record<string, string>; body?: unknown }) => {
    const t = fakeTrial({ mutationId: 'pagination_huge:limit', status: 200, body: extra.body ?? OK_LIST, query: [...q, ['limit', '100000']] });
    return { ...t, response: { ...(t.response as object), ...(extra.body !== undefined ? { body: extra.body } : {}), headers: { 'content-type': 'application/json', ...(extra.headers ?? {}) }, arrayLengths: extra.arrayLengths } };
  };
  const run = (t: Trial) => {
    resetIds();
    const base = fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q });
    const present = fakeTrial({ mutationId: 'optional_present:limit', status: 200, body: OK_LIST, query: [...q, ['limit', '1']] }); // the comparison base for an optional param
    return rulesClaims([base, present, { ...t, id: present.id + 1 }], [itemsEndpoint]).find((c) => c.claim_key === 'rule:page_size_clamp:get_v1_items:limit');
  };
  // 17 items, no Link, no total, documented maximum 100 not reached: the collection may just have 17 items.
  assert.equal(run(huge({ arrayLengths: { '': 17 } })), undefined);
  // Link rel="next": more pages exist, so 17 is a cap.
  assert.match(run(huge({ arrayLengths: { '': 17 }, headers: { link: '<https://x/v1/items?page=2>; rel="next", <https://x/v1/items?page=9>; rel="last"' } }))!.statement, /values above 17 are clamped \(documented maximum 100\)/);
  // A total field above the returned count.
  assert.match(run(huge({ arrayLengths: { items: 30 }, body: { items: [{ id: 1 }], total: 500 } }))!.statement, /"limit"=100000 returns 30 item\(s\): values above 30 are clamped/);
  // The documented maximum reached.
  assert.match(run(huge({ arrayLengths: { '': 100 } }))!.statement, /values above 100 are clamped \(documented maximum 100\)/);
});

test('rules: a date probe answered with 200 is classified by what came back: impossible filter (empty list), ignored (same count), interpreted, or plain accepted', () => {
  resetIds();
  const ep = { ...itemsEndpoint, params: [...itemsEndpoint.params, { name: 'since', in: 'query' as const, required: false, type: 'string' as const, format: 'date-time', explode: true }] };
  const q: [string, string][] = [['q', 'hello']];
  const list = (n: number) => ({ items: Array.from({ length: Math.min(n, 5) }, (_, i) => ({ id: i })), total: n });
  const withLen = (t: Trial, n: number | null) => ({ ...t, response: { ...(t.response as object), ...(n === null ? {} : { arrayLengths: { items: n } }) } });
  const trials = [
    fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }),
    withLen(fakeTrial({ mutationId: 'optional_present:since', status: 200, body: list(5), query: [...q, ['since', '2026-01-01T00:00:00Z']] }), 5),
    withLen(fakeTrial({ mutationId: 'datetime_invalid:since', status: 200, body: list(0), query: [...q, ['since', 'not-a-date']] }), 0),
    withLen(fakeTrial({ mutationId: 'datetime_epoch:since', status: 200, body: list(5), query: [...q, ['since', '1768478400']] }), 5),
    withLen(fakeTrial({ mutationId: 'datetime_date_only:since', status: 200, body: list(3), query: [...q, ['since', '2026-01-15']] }), 3),
    fakeTrial({ mutationId: 'datetime_no_tz:since', status: 422, body: ERR('validation_failed', 'since must be ISO 8601'), query: [...q, ['since', '2026-01-15T12:00:00']] }),
  ];
  const byKey = Object.fromEntries(rulesClaims(trials, [ep]).map((c) => [c.claim_key, c]));
  const invalid = byKey['rule:datetime_invalid:get_v1_items:since'];
  assert.equal(invalid.kind, 'error_behavior');
  assert.match(invalid.statement, /accepts a non-date string \("not-a-date"\) with HTTP 200 but returns an EMPTY list, where the same request with "since"=2026-01-01T00:00:00Z returned 5 item\(s\): the invalid value is silently applied as a filter that matches nothing/);
  assert.match(byKey['rule:datetime_epoch:get_v1_items:since'].statement, /returns the same 5 item\(s\) as "since"=2026-01-01T00:00:00Z: the value appears to be ignored/);

  // Equal counts on a FULL page (Link rel="next", or the default page size reached) prove nothing: say so.
  resetIds();
  const linked = (t: Trial) => ({ ...t, response: { ...(t.response as object), headers: { 'content-type': 'application/json', link: '<http://x/v1/items?page=2>; rel="next"' } } });
  const full = rulesClaims(
    [
      fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }),
      linked(withLen(fakeTrial({ mutationId: 'optional_present:since', status: 200, body: list(30), query: [...q, ['since', '2026-01-01T00:00:00Z']] }), 30)),
      linked(withLen(fakeTrial({ mutationId: 'datetime_epoch:since', status: 200, body: list(30), query: [...q, ['since', '1768478400']] }), 30)),
    ],
    [ep],
  ).find((c) => c.claim_key === 'rule:datetime_epoch:get_v1_items:since')!;
  assert.match(full.statement, /returns a full page of 30 item\(s\), as does "since"=2026-01-01T00:00:00Z; whether the value is applied cannot be told from the result count/);
  resetIds();
  const epWithDefault = { ...ep, params: ep.params.map((p) => (p.name === 'limit' ? { ...p, default: 30 } : p)) };
  const byDefault = rulesClaims(
    [
      fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }),
      withLen(fakeTrial({ mutationId: 'optional_present:since', status: 200, body: list(30), query: [...q, ['since', '2026-01-01T00:00:00Z']] }), 30),
      withLen(fakeTrial({ mutationId: 'datetime_epoch:since', status: 200, body: list(30), query: [...q, ['since', '1768478400']] }), 30),
    ],
    [epWithDefault],
  ).find((c) => c.claim_key === 'rule:datetime_epoch:get_v1_items:since')!;
  assert.match(byDefault.statement, /returns a full page of 30 item\(s\)/);
  assert.match(byKey['rule:datetime_date_only:get_v1_items:since'].statement, /returns 3 item\(s\) where "since"=2026-01-01T00:00:00Z returned 5: the value is interpreted/);
  assert.equal(byKey['rule:datetime_no_tz:get_v1_items:since'].verdict, 'rejects');
  assert.match(byKey['rule:datetime_no_tz:get_v1_items:since'].statement, /rejects an ISO date-time without a timezone designator .* with HTTP 422/);

  // No array lengths recorded (not a list endpoint): the plain wording.
  resetIds();
  const plain = rulesClaims(
    [
      fakeTrial({ mutationId: 'baseline', status: 200, body: { id: 1 }, query: q }),
      fakeTrial({ mutationId: 'optional_present:since', status: 200, body: { id: 1 }, query: [...q, ['since', '2026-01-01T00:00:00Z']] }),
      fakeTrial({ mutationId: 'datetime_invalid:since', status: 200, body: { id: 1 }, query: [...q, ['since', 'not-a-date']] }),
    ],
    [ep],
  ).find((c) => c.claim_key === 'rule:datetime_invalid:get_v1_items:since')!;
  assert.equal(plain.statement, 'Date parameter "since" accepts a non-date string ("not-a-date") (HTTP 200).');
});
