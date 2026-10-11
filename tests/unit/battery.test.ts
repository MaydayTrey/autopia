import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryHash, buildBaseline, planTrials, valueFor } from '../../src/worker/battery/index.js';
import { buildUrl, hashInput } from '../../src/worker/http.js';
import { validateTarget } from '../../src/worker/target.js';
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
    'bad_auth',
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
  assert.equal(buildUrl(plan['bad_auth'].input), 'http://x/v1/items?q=hello&api_key=invalid-key-autopia');
  assert.equal(plan['path_trailing_slash'].input.url, 'http://x/v1/items/');
  assert.equal(plan['method_head'].input.method, 'HEAD');
  assert.equal(plan['wrong_content_type'].input.headers.accept, 'application/xml');
  assert.equal(plan['boundary_long_string:q'].input.query[0][1].length, 2048);
});

test('batteryHash is stable', () => {
  assert.equal(batteryHash(), batteryHash());
  assert.match(batteryHash(), /^[0-9a-f]{64}$/);
});
