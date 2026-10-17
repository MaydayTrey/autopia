/** The sort-contract scenario's pure parts: parameter discovery, field lookup, order checks, claims. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOrdered, sortClaims, sortFieldFor, sortParams, type SortObs } from '../../src/worker/scenarios/sorting.js';
import { itemsEndpoint } from '../helpers.js';
import type { EndpointSpec, ParamSpec } from '../../src/worker/spec.js';

const p = (name: string, extra: Partial<ParamSpec> = {}): ParamSpec => ({ name, in: 'query', required: false, type: 'string', explode: false, ...extra });
const ep: EndpointSpec = { ...itemsEndpoint, params: [...itemsEndpoint.params, p('order_by', { enum: ['id', 'name'] }), p('direction', { enum: ['asc', 'desc'] })] };

test('sortParams: the sort key values come from the target then the enum (max 3); directions pair desc/asc when the enum has them', () => {
  const sp = sortParams(ep, { name: 'x', spec_url: 'y', optional_values: { '/v1/items': { order_by: 'name' } } })!;
  assert.equal(sp.sort.name, 'order_by');
  assert.equal(sp.direction?.name, 'direction');
  assert.deepEqual(sp.keys, ['name', 'id']);
  assert.deepEqual(sp.directions, ['desc', 'asc']);
  assert.deepEqual(sortParams(ep, { name: 'x', spec_url: 'y' })!.keys, ['id', 'name'], 'no target value: the enum alone');
  // A lone "sort" whose enum is only asc|desc is still the only candidate: its values become the keys and there is no direction parameter.
  assert.deepEqual(sortParams(itemsEndpoint, { name: 'x', spec_url: 'y' })!.keys, ['asc', 'desc']);
  // With a real key parameter beside it, the direction-only "sort" loses: the target's value wins, then the non-direction enum.
  assert.equal(sortParams(ep, { name: 'x', spec_url: 'y' })!.sort.name, 'order_by');
  assert.equal(sortParams(ep, { name: 'x', spec_url: 'y', optional_values: { '/v1/items': { sort: 'asc' } } })!.sort.name, 'sort', 'unless the target names it');
  const github: EndpointSpec = { ...itemsEndpoint, params: [p('sort', { enum: ['created', 'updated', 'comments'] }), p('direction', { enum: ['asc', 'desc'] })] };
  assert.deepEqual(sortParams(github, { name: 'x', spec_url: 'y', optional_values: { '/v1/items': { sort: 'created' } } })!.keys, ['created', 'updated', 'comments']);
  const noDir: EndpointSpec = { ...itemsEndpoint, params: [p('sort', { enum: ['stars', 'forks'] })] };
  assert.deepEqual(sortParams(noDir, { name: 'x', spec_url: 'y' })!.directions, []);
});

test('sortFieldFor: exact field, suffixes, well-known aliases; null when nothing matches', () => {
  assert.equal(sortFieldFor('name', { name: 'a' }), 'name');
  assert.equal(sortFieldFor('created', { created_at: '2026-01-01T00:00:00Z' }), 'created_at');
  assert.equal(sortFieldFor('updated', { updated_at: 'x' }), 'updated_at');
  assert.equal(sortFieldFor('stars', { stargazers_count: 5 }), 'stargazers_count');
  assert.equal(sortFieldFor('comments', { comments: 3 }), 'comments');
  assert.equal(sortFieldFor('popularity', { score: 1.5 }), 'score');
  assert.equal(sortFieldFor('best-match', { id: 1 }), null);
  assert.equal(sortFieldFor('name', { name: { first: 'x' } }), null, 'only scalar fields can be ordered');
});

test('isOrdered: numbers, ISO timestamps, numeric-aware strings; nulls make it unknown; one value is unknown', () => {
  assert.equal(isOrdered([1, 2, 2, 5], 'asc'), true);
  assert.equal(isOrdered([5, 2, 2, 1], 'desc'), true);
  assert.equal(isOrdered([1, 3, 2], 'asc'), false);
  assert.equal(isOrdered(['2026-10-17T10:00:00Z', '2026-10-16T10:00:00Z'], 'desc'), true);
  assert.equal(isOrdered(['2026-10-17T01:00:00+02:00', '2026-10-17T00:00:00Z'], 'desc'), false, 'ISO strings compare as instants: 01:00+02:00 is 23:00Z the day before');
  assert.equal(isOrdered(['2026-10-17T00:00:00Z', '2026-10-17T01:00:00+02:00'], 'desc'), true);
  assert.equal(isOrdered(['item 1', 'item 2', 'item 10'], 'asc'), true, 'numeric collation');
  assert.equal(isOrdered(['item 10', 'item 2'], 'asc'), false);
  assert.equal(isOrdered([1, null, 3], 'asc'), null);
  assert.equal(isOrdered([1], 'asc'), null);
});

function obs(trialId: number, key: string | null, direction: string | null, items: Record<string, unknown>[], status = 200): SortObs {
  return { trialId, status, key, direction, ids: items.map((it) => `id=${it.id}`), items, isList: status < 300 };
}
const ITEMS = [1, 2, 3].map((id) => ({ id, name: `item ${id}` }));
const rev = [...ITEMS].reverse();
const statuses = (...o: SortObs[]) => new Map(o.map((x) => [x.trialId, { statusCode: x.status }]));

test('sortClaims: honored both ways, default named, stable; an ignored key seen twice; same page for both directions', () => {
  const base = obs(1, null, null, ITEMS);
  const nameDesc = obs(2, 'name', 'desc', rev);
  const nameAsc = obs(3, 'name', 'asc', ITEMS);
  const idDesc = obs(4, 'id', 'desc', rev);
  const idAsc = obs(5, 'id', 'asc', ITEMS);
  const again = obs(6, 'name', 'desc', rev);
  const claims = sortClaims('GET /v1/items', 'order_by', 'direction', base, [nameDesc, nameAsc, idDesc, idAsc], [again], statuses(base, nameDesc, nameAsc, idDesc, idAsc, again));
  const by = Object.fromEntries(claims.map((c) => [c.claim_key, c]));
  assert.match(by['scenario:sort:get_v1_items:name_desc'].statement, /^order_by=name&direction=desc orders the page by "name" descending \(HTTP 200\)\.$/);
  assert.match(by['scenario:sort:get_v1_items:id_asc'].statement, /orders the page by "id" ascending/);
  assert.match(by['scenario:sort_default:get_v1_items:-'].statement, /^The default order equals order_by=name&direction=asc and order_by=id&direction=asc: an unsorted request returned the same page in the same order as each of them \(HTTP 200\); they are indistinguishable on this page, and the default is one of them\./, 'every sorted page that equals the unsorted one is named, with the caveat');
  assert.ok(!('scenario:sort_direction:get_v1_items:name' in by));
  assert.match(by['scenario:sort_stable:get_v1_items:-'].statement, /order_by=name&direction=desc read twice a few seconds apart returned the same ids in the same order \(HTTP 200\): the order is reproducible between reads; new or changed items can still shift later pages/);

  // Ignored key: both directions return the unsorted (id-ordered) page; name desc fails its field check twice.
  const deafDesc = obs(2, 'name', 'desc', ITEMS);
  const deafAsc = obs(3, 'name', 'asc', ITEMS);
  const deafAgain = obs(6, 'name', 'desc', ITEMS);
  const c2 = sortClaims('GET /v1/items', 'order_by', 'direction', base, [deafDesc, deafAsc], [deafAgain], statuses(base, deafDesc, deafAsc, deafAgain));
  const b2 = Object.fromEntries(c2.map((c) => [c.claim_key, c]));
  assert.match(b2['scenario:sort:get_v1_items:name_desc'].statement, /does NOT order the page by "name" descending, and the page is identical to the unsorted one \(HTTP 200, seen twice\)\. The other direction, order_by=name&direction=asc, IS ordered by "name"\. The key is ignored, or that is the default order; sort client-side/);
  assert.deepEqual(b2['scenario:sort:get_v1_items:name_desc'].evidence_trial_ids, [1, 2, 3, 6], 'the ordered sibling is cited too');
  assert.match(b2['scenario:sort:get_v1_items:name_asc'].statement, /orders the page by "name" ascending/, 'asc happens to hold on an id-ordered page');
  assert.match(b2['scenario:sort_direction:get_v1_items:name'].statement, /direction parameter has no effect on this key/);
  // Seen once only: no claim.
  const c3 = sortClaims('GET /v1/items', 'order_by', 'direction', base, [deafDesc], [], statuses(base, deafDesc));
  assert.ok(!c3.some((c) => c.claim_key === 'scenario:sort:get_v1_items:name_desc'));
});

test('sortClaims: no matching field -> structural facts only; a rejected documented value; nothing on a one-item page', () => {
  const base = obs(1, null, null, ITEMS);
  const changed = obs(2, 'best-match', null, rev);
  const identical = obs(3, 'relevance', null, ITEMS);
  const rejected = obs(4, 'bogus', null, [], 422);
  const c = sortClaims('GET /v1/items', 'sort', null, base, [changed, identical, rejected], [], statuses(base, changed, identical, rejected));
  const by = Object.fromEntries(c.map((x) => [x.claim_key, x]));
  assert.match(by['scenario:sort:get_v1_items:best_match'].statement, /sort=best-match changes the order of the first page relative to the unsorted one; items carry no field matching "best-match"/);
  assert.match(by['scenario:sort:get_v1_items:relevance'].statement, /leaves the first page identical to the unsorted one; items carry no field matching "relevance"/);
  assert.match(by['scenario:sort:get_v1_items:bogus'].statement, /sort=bogus \(a documented value\) is rejected with HTTP 422/);
  // Django-style "-created" keeps a distinct claim key from "created".
  const neg = sortClaims('GET /v1/items', 'ordering', null, base, [obs(2, 'id', null, ITEMS), obs(3, '-id', null, rev)], [], statuses(base));
  assert.deepEqual(neg.filter((c) => /^scenario:sort:/.test(c.claim_key)).map((c) => c.claim_key).sort(), ['scenario:sort:get_v1_items:id', 'scenario:sort:get_v1_items:minus_id']);
  assert.deepEqual(sortClaims('GET /v1/items', 'sort', null, obs(1, null, null, ITEMS.slice(0, 1)), [changed], [], statuses(base)), []);
});
