import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeRules } from '../../src/worker/aggregate/shape-rules.js';
import { fakeTrial, itemsEndpoint, resetIds } from '../helpers.js';
import type { Trial } from '../../src/db/schema.js';

function withHeaders(t: Trial, headers: Record<string, string>): Trial {
  return { ...t, response: { ...(t.response as object), headers } };
}

test('shapeRules: content type, rate-limit headers, pagination fields, nulls, timestamps', () => {
  resetIds();
  const body = { items: [{ id: 1, created_at: '2026-01-15T12:00:00Z', ended: null }], total: 1, next: null, page: 1 };
  const base = withHeaders(fakeTrial({ mutationId: 'baseline', status: 200, body }), { 'content-type': 'application/json; charset=utf-8', 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '59', 'cache-control': 'max-age=60' });
  const claims = shapeRules([base], [itemsEndpoint]);
  const by = Object.fromEntries(claims.map((c) => [c.claim_key, c]));
  assert.match(by['rule:shape_content_type:get_v1_items:-'].statement, /application\/json; charset=utf-8/);
  assert.match(by['rule:shape_rate_limit_headers:get_v1_items:-'].statement, /x-ratelimit-limit=60/);
  assert.match(by['rule:shape_rate_limit_headers:get_v1_items:-'].statement, /x-ratelimit-remaining/);
  assert.match(by['rule:shape_cache_control:get_v1_items:-'].statement, /max-age=60/);
  assert.match(by['rule:shape_pagination_fields:get_v1_items:-'].statement, /total, next, page/);
  assert.match(by['rule:shape_nulls:get_v1_items:-'].statement, /2 null-valued field/);
  assert.match(by['rule:shape_nulls:get_v1_items:-'].statement, /items\[0\]\.ended, next/);
  assert.match(by['rule:shape_timestamps:get_v1_items:-'].statement, /ISO 8601 with a Z suffix/);
  assert.match(by['rule:shape_timestamps:get_v1_items:-'].statement, /Times are UTC/);
  for (const c of claims) {
    assert.equal(c.kind, 'response_shape');
    assert.equal(c.verdict, 'observes');
    assert.deepEqual(c.evidence_trial_ids, [base.id]);
    assert.deepEqual(c.expectations, [{ trial_id: base.id, status: 200 }]);
  }
});

test('shapeRules: naive timestamps found in an optional_present trial, no rate-limit headers, no nulls', () => {
  resetIds();
  const base = withHeaders(fakeTrial({ mutationId: 'baseline', status: 200, body: { latitude: 52.5, generationtime_ms: 0.1 } }), { 'content-type': 'application/json' });
  const hourly = withHeaders(fakeTrial({ mutationId: 'optional_present:hourly', status: 200, body: { hourly: { time: ['2026-10-12T00:00', '2026-10-12T01:00'], temperature_2m: [10.1, 9.8] } } }), { 'content-type': 'application/json' });
  const claims = shapeRules([base, hourly], [itemsEndpoint]);
  const by = Object.fromEntries(claims.map((c) => [c.claim_key, c]));
  assert.match(by['rule:shape_timestamps:get_v1_items:-'].statement, /without a timezone designator/);
  assert.match(by['rule:shape_timestamps:get_v1_items:-'].statement, /NO timezone designator/);
  assert.deepEqual(by['rule:shape_timestamps:get_v1_items:-'].evidence_trial_ids, [hourly.id], 'cites the trial where timestamps were found');
  assert.match(by['rule:shape_rate_limit_headers:get_v1_items:-'].statement, /no rate-limit headers/);
  assert.match(by['rule:shape_nulls:get_v1_items:-'].statement, /no null-valued fields/);
  assert.match(by['rule:shape_pagination_fields:get_v1_items:-'].statement, /no top-level pagination fields/);
});

test('shapeRules: epoch milliseconds under time-like keys; nothing for non-JSON or failed baselines', () => {
  resetIds();
  const base = withHeaders(fakeTrial({ mutationId: 'baseline', status: 200, body: { serverTime: 1704067200000, symbols: [] } }), { 'content-type': 'application/json' });
  const claims = shapeRules([base], [itemsEndpoint]);
  const ts = claims.find((c) => c.claim_key.includes('shape_timestamps'))!;
  assert.match(ts.statement, /Unix epoch milliseconds/);
  assert.match(ts.statement, /UTC by definition/);
  resetIds();
  const failed = fakeTrial({ mutationId: 'baseline', status: 500, body: { error: 'x' } });
  assert.equal(shapeRules([failed], [itemsEndpoint]).length, 0);
  const text = withHeaders(fakeTrial({ mutationId: 'baseline', status: 200, body: 'plain text' }), { 'content-type': 'text/plain' });
  const t = shapeRules([text], [itemsEndpoint]);
  assert.ok(t.some((c) => c.claim_key.includes('shape_content_type')));
  assert.ok(!t.some((c) => c.claim_key.includes('shape_nulls')), 'body rules need JSON');
});

test('shapeRules: two timestamp formats in one response read as two formats, not one sentence glued with a semicolon', () => {
  resetIds();
  const baseline = fakeTrial({
    mutationId: 'baseline',
    status: 200,
    body: { releases: [{ upload_time: '2026-05-14T19:25:26', upload_time_iso_8601: '2026-05-14T19:25:26.443000Z' }] },
  });
  const by = Object.fromEntries(shapeRules([baseline], [itemsEndpoint]).map((c) => [c.claim_key, c]));
  const s = by['rule:shape_timestamps:get_v1_items:-'].statement;
  assert.match(s, /^Timestamps in successful responses use 2 formats: ISO 8601 with(out)? .* and ISO 8601 with(out)? /);
  assert.match(s, /check which field you read\. Times are UTC\.$/);
  assert.doesNotMatch(s, /; ISO 8601/);
});
