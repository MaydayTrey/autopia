import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryHash, buildBaseline, invalidCredentialLike, planTrials, valueFor } from '../../src/worker/battery/index.js';
import { buildUrl, hashInput } from '../../src/worker/http.js';
import { validateTarget } from '../../src/worker/target.js';
import type { EndpointSpec } from '../../src/worker/spec.js';
import { itemsEndpoint } from '../helpers.js';

const target = validateTarget({ name: 'mock', spec_url: 'x', baseline: { '/v1/items': { q: 'hello' } }, optional_values: { '/v1/items': { sort: 'desc' } } });

test('valueFor precedence: override > example > default > enum > type', () => {
  const p = { name: 'x', in: 'query' as const, required: false, type: 'integer' as const, explode: true };
  assert.equal(valueFor({ ...p, example: 7, default: 3, enum: ['9'] }, '42'), '42');
  assert.equal(valueFor({ ...p, example: 7, default: 3, enum: ['9'] }), '7');
  assert.equal(valueFor({ ...p, default: 3, enum: ['9'] }), '3');
  assert.equal(valueFor({ ...p, type: 'string', enum: ['9', '8'] }), '9');
  assert.equal(valueFor(p), '1');
  assert.equal(valueFor({ ...p, minimum: 5 }), '5'); // clamped into documented range
  assert.equal(valueFor({ ...p, type: 'number' }), '1.5');
  assert.equal(valueFor({ ...p, type: 'boolean' }), 'true');
  assert.equal(valueFor({ ...p, type: 'string', format: 'date' }), '2026-01-15');
  assert.equal(valueFor({ ...p, type: 'array', itemType: 'string', enum: ['a', 'b'] }), 'a');
});

test('buildBaseline: required query params only, target values win', () => {
  const b = buildBaseline(itemsEndpoint, target);
  assert.deepEqual(b.input.query, [['q', 'hello']]);
  assert.equal(b.input.url, 'http://x/v1/items');
  assert.deepEqual(b.required.map((p) => p.name), ['q']);
  assert.deepEqual(b.optional.map((p) => p.name), ['limit', 'page', 'sort', 'api_key']);
});

test('planTrials is deterministic and covers the battery', () => {
  const a = planTrials(itemsEndpoint, target);
  const b = planTrials(itemsEndpoint, target);
  assert.deepEqual(a, b);
  assert.deepEqual(a.map((m) => hashInput(m.input)), b.map((m) => hashInput(m.input)));

  const ids = a.map((m) => m.id);
  assert.equal(ids[0], 'baseline');
  for (const expected of [
    'required_omitted:q',
    'optional_present:limit',
    'optional_present:sort',
    'wrong_type:limit',
    'enum_invalid:sort',
    'null_value:q',
    'empty_value:limit',
    'boundary_zero:limit',
    'boundary_negative:page',
    'boundary_max_int:limit',
    'boundary_below_min:limit',
    'boundary_above_max:limit',
    'boundary_far_above_max:limit',
    'boundary_long_string:q',
    'duplicate_param:q',
    'pagination_zero:page',
    'pagination_huge:limit',
    'extra_field',
    'bad_auth:api_key',
    'wrong_content_type',
    'path_trailing_slash',
    'method_head',
  ]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  assert.ok(!ids.includes('required_all_omitted'), 'only one required param, so no all-omitted probe');
  assert.ok(!ids.includes('wrong_type:q'), 'strings have no wrong-type probe');
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('planTrials: mutation contents', () => {
  const plan = Object.fromEntries(planTrials(itemsEndpoint, target).map((m) => [m.id, m]));
  assert.deepEqual(plan['required_omitted:q'].input.query, []);
  assert.equal(plan['required_omitted:q'].baseOf, 'baseline');
  assert.deepEqual(plan['optional_present:limit'].input.query, [['q', 'hello'], ['limit', '1']]); // min 1
  assert.deepEqual(plan['optional_present:sort'].input.query, [['q', 'hello'], ['sort', 'desc']]); // target optional value
  assert.equal(plan['wrong_type:limit'].baseOf, 'optional_present:limit');
  assert.equal(buildUrl(plan['wrong_type:limit'].input), 'http://x/v1/items?q=hello&limit=abc');
  assert.equal(buildUrl(plan['boundary_above_max:limit'].input), 'http://x/v1/items?q=hello&limit=101');
  assert.equal(buildUrl(plan['boundary_below_min:limit'].input), 'http://x/v1/items?q=hello&limit=0');
  assert.equal(buildUrl(plan['boundary_far_above_max:limit'].input), 'http://x/v1/items?q=hello&limit=1000');
  assert.equal(buildUrl(plan['enum_invalid:sort'].input), 'http://x/v1/items?q=hello&sort=not_a_documented_value');
  assert.equal(buildUrl(plan['duplicate_param:q'].input), 'http://x/v1/items?q=hello&q=hello2');
  assert.equal(buildUrl(plan['extra_field'].input), 'http://x/v1/items?q=hello&autopia_unknown_param=1');
  assert.equal(buildUrl(plan['bad_auth:api_key'].input), 'http://x/v1/items?q=hello&api_key=invalid-key-autopia');
  assert.equal(plan['path_trailing_slash'].input.url, 'http://x/v1/items/');
  assert.equal(plan['method_head'].input.method, 'HEAD');
  assert.equal(plan['wrong_content_type'].input.headers.accept, 'application/xml');
  assert.equal(plan['boundary_long_string:q'].input.query[0][1].length, 2048);
});

test('planTrials: path parameters get the per-parameter probes; auth probes target declared schemes', () => {
  const ep: EndpointSpec = {
    method: 'GET',
    path: '/v1/stations/{stationId}/obs/{n}',
    server: 'http://x',
    hasSecurity: true,
    authSchemes: [
      { scheme: 'ua', name: 'User-Agent', in: 'header' },
      { scheme: 'k', name: 'api_key', in: 'query' },
    ],
    params: [
      { name: 'stationId', in: 'path', required: true, type: 'string', explode: true },
      { name: 'n', in: 'path', required: true, type: 'integer', minimum: 1, maximum: 10, explode: true },
      { name: 'api_key', in: 'query', required: false, type: 'string', explode: true },
    ],
  };
  const t = validateTarget({ name: 'p', spec_url: 'x', baseline: { '/v1/stations/{stationId}/obs/{n}': { stationId: 'KTOP' } } });
  const plan = Object.fromEntries(planTrials(ep, t).map((m) => [m.id, m]));

  assert.equal(plan.baseline.input.url, 'http://x/v1/stations/KTOP/obs/1');
  assert.deepEqual(plan.baseline.input.pathParams, { stationId: 'KTOP', n: '1' });
  assert.equal(plan['wrong_type:n'].input.url, 'http://x/v1/stations/KTOP/obs/abc');
  assert.equal(plan['empty_value:stationId'].input.url, 'http://x/v1/stations//obs/1');
  assert.equal(plan['null_value:stationId'].input.url, 'http://x/v1/stations/null/obs/1');
  assert.equal(plan['boundary_above_max:n'].input.url, 'http://x/v1/stations/KTOP/obs/11');
  assert.equal(plan['boundary_far_above_max:n'].input.url, 'http://x/v1/stations/KTOP/obs/100');
  assert.equal(plan['boundary_long_string:stationId'].input.pathParams?.stationId.length, 2048);
  assert.equal(plan['wrong_type:n'].baseOf, 'baseline');
  assert.ok(!('required_omitted:stationId' in plan), 'path params cannot be omitted; the empty segment is the probe');

  // auth: header scheme -> bad value + '' (send no header); query scheme -> bad value only (baseline has none to omit)
  assert.equal(plan['bad_auth:User-Agent'].input.headers['user-agent'], 'invalid-key-autopia');
  assert.equal(plan['no_auth:User-Agent'].input.headers['user-agent'], '');
  assert.equal(buildUrl(plan['bad_auth:api_key'].input), 'http://x/v1/stations/KTOP/obs/1?api_key=invalid-key-autopia');
  assert.ok(!('no_auth:api_key' in plan));
  assert.ok(!('bad_auth' in plan), 'legacy generic auth probe is replaced by scheme-specific ones');
  assert.deepEqual(planTrials(ep, t), planTrials(ep, t), 'deterministic');
});

test('batteryHash is stable', () => {
  assert.equal(batteryHash(), batteryHash());
  assert.match(batteryHash(), /^[0-9a-f]{64}$/);
});

test('planTrials: auth fallback probes only a header the target actually sends; bare security gets none', () => {
  // drop api_key so the query-param heuristic does not fire; this test is about the header fallback
  const secured: EndpointSpec = { ...itemsEndpoint, hasSecurity: true, authSchemes: [], params: itemsEndpoint.params.filter((p) => p.name !== 'api_key') };
  const noneSent = planTrials(secured, validateTarget({ name: 'a', spec_url: 'x', baseline: { '/v1/items': { q: 'hello' } } }));
  assert.ok(!noneSent.some((m) => m.type === 'bad_auth' && m.param === null), 'no generic Authorization guess');
  const withHeader = Object.fromEntries(
    planTrials(secured, validateTarget({ name: 'a', spec_url: 'x', baseline: { '/v1/items': { q: 'hello' } }, headers: { 'x-api-key': 'real' } })).map((m) => [m.id, m]),
  );
  assert.equal(withHeader['bad_auth:x-api-key'].input.headers['x-api-key'], 'invalid-key-autopia');
  assert.equal(withHeader['no_auth:x-api-key'].input.headers['x-api-key'], '');
  assert.equal(withHeader.baseline.input.headers['x-api-key'], 'real');
});

test('bad_auth preserves the credential scheme; date-time params get format probes', () => {
  assert.equal(invalidCredentialLike('Bearer ghp_real'), 'Bearer invalid-key-autopia');
  assert.equal(invalidCredentialLike('token abc'), 'token invalid-key-autopia');
  assert.match(invalidCredentialLike('Basic dXNlcjpwYXNz'), /^Basic [A-Za-z0-9+/=]+$/);
  assert.equal(invalidCredentialLike('raw-key'), 'invalid-key-autopia');
  assert.equal(invalidCredentialLike(undefined), 'invalid-key-autopia');

  const ep: EndpointSpec = { ...itemsEndpoint, authSchemes: [], params: [{ name: 'since', in: 'query', required: false, type: 'string', format: 'date-time', explode: true }, { name: 'q', in: 'query', required: true, type: 'string', explode: true }] };
  const t = validateTarget({ name: 'd', spec_url: 'x', baseline: { '/v1/items': { q: 'hello' } }, headers: { authorization: 'Bearer real' } });
  const plan = Object.fromEntries(planTrials(ep, t).map((m) => [m.id, m]));
  assert.equal(buildUrl(plan['datetime_date_only:since'].input), 'http://x/v1/items?q=hello&since=2026-01-15');
  assert.equal(buildUrl(plan['datetime_no_tz:since'].input), 'http://x/v1/items?q=hello&since=2026-01-15T12%3A00%3A00');
  assert.equal(buildUrl(plan['datetime_epoch:since'].input), 'http://x/v1/items?q=hello&since=1768478400');
  assert.equal(buildUrl(plan['datetime_invalid:since'].input), 'http://x/v1/items?q=hello&since=not-a-date');
  assert.equal(plan['datetime_no_tz:since'].baseOf, 'optional_present:since');
  assert.ok(!('datetime_epoch:q' in plan), 'plain strings get no date probes');
  assert.equal(plan['bad_auth:authorization'].input.headers.authorization, 'Bearer invalid-key-autopia', 'legacy header fallback keeps the scheme');
});
