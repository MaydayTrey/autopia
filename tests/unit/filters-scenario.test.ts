/**
 * The filter-composition scenario's pure parts: which parameters count as filters, field matching
 * on items, and the claims made from an unfiltered page, single-filter pages and pair pages.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldMatches, filterClaims, filterConfig, filterParams, pageFieldCheck, type FilterObs } from '../../src/worker/scenarios/filters.js';
import { itemsEndpoint } from '../helpers.js';

test('filterParams: optional query params with a known-good value, minus paging, sorting and credentials', () => {
  const ep = { ...itemsEndpoint, params: [...itemsEndpoint.params, { name: 'kind', in: 'query' as const, required: false, type: 'string' as const, enum: ['odd', 'even'], explode: false }, { name: 'tag', in: 'query' as const, required: false, type: 'string' as const, explode: false }] };
  const t = { name: 'x', spec_url: 'y', optional_values: { '/v1/items': { kind: 'odd', tag: 'x', limit: '5', sort: 'asc', page: '2' } } };
  assert.deepEqual(filterParams(ep, t).map((f) => [f.param.name, f.value]), [['kind', 'odd'], ['tag', 'x']]);
  assert.deepEqual(filterParams(ep, { name: 'x', spec_url: 'y' }), [], 'no known-good values: no filters');
  // A credential-named parameter is never a filter: its value would be printed into a published statement.
  const epSig = { ...ep, params: [...ep.params, { name: 'signature', in: 'query' as const, required: false, type: 'string' as const, explode: false }] };
  assert.deepEqual(filterParams(epSig, { name: 'x', spec_url: 'y', optional_values: { '/v1/items': { signature: 'hmac-secret', kind: 'odd' } } }).map((f) => f.param.name), ['kind']);
  assert.deepEqual(filterConfig({ name: 'x', spec_url: 'y' }), { page_size: 20, max_filters: 4 });
  assert.equal(filterConfig({ name: 'x', spec_url: 'y', scenarios: { filters: false } }), null);
});

test('fieldMatches: scalars, objects by login/name/id, arrays of labels, wildcard, missing field', () => {
  assert.equal(fieldMatches({ state: 'open' }, 'state', 'open'), true);
  assert.equal(fieldMatches({ state: 'closed' }, 'state', 'open'), false);
  assert.equal(fieldMatches({ state: 'Open' }, 'state', 'open'), true, 'case-insensitive');
  assert.equal(fieldMatches({ user: { login: 'octocat', id: 1 } }, 'user', 'octocat'), true);
  assert.equal(fieldMatches({ milestone: { id: 7, title: 'v1' } }, 'milestone', '7'), true);
  assert.equal(fieldMatches({ labels: [{ name: 'bug' }, { name: 'docs' }] }, 'labels', 'bug'), true);
  assert.equal(fieldMatches({ labels: [{ name: 'bug' }, { name: 'docs' }] }, 'labels', 'bug,docs'), true);
  assert.equal(fieldMatches({ labels: [{ name: 'bug' }] }, 'labels', 'bug,docs'), false);
  assert.equal(fieldMatches({ labels: ['bug'] }, 'labels', 'bug'), true, 'arrays of strings');
  assert.equal(fieldMatches({ assignee: { login: 'x' } }, 'assignee', '*'), true);
  assert.equal(fieldMatches({ assignee: null }, 'assignee', '*'), false);
  assert.equal(fieldMatches({ labels: [] }, 'labels', '*'), false);
  assert.equal(fieldMatches({ id: 1 }, 'since', '2026-01-01'), null, 'no such field: not checkable');
});

function obs(trialId: number, filters: Record<string, string>, items: Record<string, unknown>[], complete = true, status = 200): FilterObs {
  return { trialId, status, filters, ids: items.map((it) => `id=${it.id}`), items, complete, isList: status < 300 };
}
const ALL = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, kind: (i + 1) % 2 ? 'odd' : 'even', tag: 'none' }));
const ODD = ALL.filter((it) => it.kind === 'odd');
const statuses = (...o: FilterObs[]) => new Map(o.map((x) => [x.trialId, { statusCode: x.status }]));

test('pageFieldCheck counts matches, mismatches and unjudgeable items', () => {
  assert.deepEqual(pageFieldCheck(obs(1, { kind: 'odd' }, ODD), 'kind', 'odd'), { match: 4, mismatch: 0, unknown: 0 });
  assert.deepEqual(pageFieldCheck(obs(1, { tag: 'x' }, ALL), 'tag', 'x'), { match: 0, mismatch: 7, unknown: 0 });
  assert.deepEqual(pageFieldCheck(obs(1, { since: 's' }, ALL), 'since', 's'), { match: 0, mismatch: 0, unknown: 7 });
});

test('filterClaims: honored, ignored (seen twice), unchecked-but-identical, unchecked-but-changed, rejected', () => {
  const base = obs(1, {}, ALL);
  const kind = obs(2, { kind: 'odd' }, ODD);
  const tag = obs(3, { tag: 'x' }, ALL);
  const tagAgain = obs(4, { tag: 'x' }, ALL);
  const since = obs(5, { since: '2026-01-01' }, ALL);
  const author = obs(6, { author: 'octocat' }, ALL.slice(0, 2));
  const bad = obs(7, { kind: 'odd' }, [], true, 422);
  const claims = filterClaims('GET /v1/items', base, [{ obs: kind, again: null }, { obs: tag, again: tagAgain }, { obs: since, again: null }, { obs: author, again: null }], [], statuses(base, kind, tag, tagAgain, since, author));
  const by = Object.fromEntries(claims.map((c) => [c.claim_key, c]));
  assert.match(by['scenario:filter:get_v1_items:kind'].statement, /is honored: every item on the first page matches on field "kind" \(HTTP 200\)/);
  assert.match(by['scenario:filter:get_v1_items:tag'].statement, /has no visible effect: the first page is identical to the unfiltered one and none of its items has "tag" equal to that value \(HTTP 200, seen twice\)\. The value is either the default or the parameter is ignored; it does not select items by their "tag" field\./);
  assert.deepEqual(by['scenario:filter:get_v1_items:tag'].evidence_trial_ids, [1, 3, 4]);
  assert.match(by['scenario:filter:get_v1_items:since'].statement, /leaves the first page identical to the unfiltered one \(same ids, same order; items carry no "since" field to check against\)/);
  assert.match(by['scenario:filter:get_v1_items:author'].statement, /changes the result \(a different first page\); items carry no "author" field/);
  assert.equal(by['scenario:filter:get_v1_items:kind'].param, 'kind');
  // A mismatch seen only once is not claimed.
  const once = filterClaims('GET /v1/items', base, [{ obs: tag, again: obs(8, { tag: 'x' }, ALL.map((it) => ({ ...it, tag: 'x' }))) }], [], statuses(base, tag));
  assert.ok(!once.some((c) => /filter:get_v1_items:tag/.test(c.claim_key)));
  // A rejected known-good value is reported as such.
  const rej = filterClaims('GET /v1/items', base, [{ obs: bad, again: null }], [], statuses(base, bad));
  assert.match(rej[0].statement, /is rejected with HTTP 422; it cannot be checked as a filter/);
});

test('filterClaims: pairs compose, or one filter disables the other, or the combination is empty, or it is rejected', () => {
  const base = obs(1, {}, ALL);
  const kind = obs(2, { kind: 'odd' }, ODD);
  const tag = obs(3, { tag: 'x' }, ALL);
  const singles = [{ obs: kind, again: null }, { obs: tag, again: obs(4, { tag: 'x' }, ALL) }];
  // tag's own check failed, so tag is not field-checked inside the pair: consistent on kind and on containment.
  const pair = obs(5, { kind: 'odd', tag: 'x' }, ODD);
  const c1 = filterClaims('GET /v1/items', base, singles, [{ obs: pair, again: null }], statuses(base, kind, tag, pair));
  const combo = c1.find((c) => c.claim_key === 'scenario:filter_combo:get_v1_items:kind_tag')!;
  assert.match(combo.statement, /is consistent: a non-empty result, all within the result of "kind" and "tag" alone, every item matching "kind" \(HTTP 200\)/);
  assert.deepEqual(combo.evidence_trial_ids, [2, 3, 5]);
  // Fully consistent pair: items match both fields and sit inside each complete single result.
  const ODD_X = ODD.map((it) => ({ ...it, tag: 'x' }));
  const good = filterClaims('GET /v1/items', obs(1, {}, ALL.map((it) => ({ ...it, tag: 'x' }))), [{ obs: obs(2, { kind: 'odd' }, ODD_X), again: null }, { obs: obs(3, { tag: 'x' }, ALL.map((it) => ({ ...it, tag: 'x' }))), again: null }], [{ obs: obs(5, { kind: 'odd', tag: 'x' }, ODD_X), again: null }], statuses(base, kind, tag, pair));
  assert.match(good.find((c) => /filter_combo/.test(c.claim_key))!.statement, /is consistent: a non-empty result, all within the result of "kind" and "tag" alone, every item matching "kind" and "tag" \(HTTP 200\)/);
  // One filter disabled by the other: the pair returns items outside the complete single result.
  const disabled = obs(5, { kind: 'odd', tag: 'x' }, ALL.map((it) => ({ ...it, tag: 'x' })));
  const d = filterClaims('GET /v1/items', base, [{ obs: obs(2, { kind: 'odd' }, ODD_X), again: null }, { obs: obs(3, { tag: 'x' }, ALL.map((it) => ({ ...it, tag: 'x' }))), again: null }], [{ obs: disabled, again: { ...disabled, trialId: 6 } }], statuses(base, kind, tag, disabled, { ...disabled, trialId: 6 }));
  assert.match(d.find((c) => /filter_combo/.test(c.claim_key))!.statement, /items appear that are not in the result of "kind" alone, so "kind" is disabled by the combination; returned items do not match "kind"/);
  // Empty combination although items match both individually.
  const empty = obs(5, { kind: 'odd', tag: 'x' }, []);
  const e = filterClaims('GET /v1/items', base, [{ obs: obs(2, { kind: 'odd' }, ODD_X), again: null }, { obs: obs(3, { tag: 'x' }, ALL.map((it) => ({ ...it, tag: 'x' }))), again: null }], [{ obs: empty, again: { ...empty, trialId: 6 } }], statuses(base, kind, tag, empty, { ...empty, trialId: 6 }));
  assert.match(e.find((c) => /filter_combo/.test(c.claim_key))!.statement, /returns nothing although items match both filters individually/);
  // An incomplete single result is not a reference set: no containment claim from it, field checks only.
  const partial = filterClaims('GET /v1/items', base, [{ obs: obs(2, { kind: 'odd' }, ODD_X, false), again: null }, { obs: obs(3, { tag: 'x' }, ALL.map((it) => ({ ...it, tag: 'x' })), false), again: null }], [{ obs: obs(5, { kind: 'odd', tag: 'x' }, ODD_X, false), again: null }], statuses(base, kind, tag, pair));
  assert.match(partial.find((c) => /filter_combo/.test(c.claim_key))!.statement, /is consistent: a non-empty result, every item matching "kind" and "tag" \(HTTP 200\)/);
  // A zero-item single result for the target's value is not claimed (it describes the data, not the API).
  const zero = filterClaims('GET /v1/items', base, [{ obs: obs(9, { author: 'nobody' }, []), again: null }], [], statuses(base));
  assert.ok(!zero.some((c) => /filter:get_v1_items:author/.test(c.claim_key)));
  // Rejected pair while each single is accepted.
  const rejPair = obs(5, { kind: 'odd', tag: 'x' }, [], true, 400);
  const r = filterClaims('GET /v1/items', base, singles, [{ obs: rejPair, again: null }], statuses(base, kind, tag, rejPair));
  assert.match(r.find((c) => /filter_combo/.test(c.claim_key))!.statement, /is rejected with HTTP 400 although each filter alone is accepted/);
});

test('filterClaims: an empty combination with no detectable problem is not claimed (vacuous consistency)', () => {
  const base = obs(1, {}, ALL);
  const a = obs(2, { kind: 'odd' }, ODD);
  const b = obs(3, { author: 'nobody' }, []); // complete and empty: the intersection is empty too
  const claims = filterClaims('GET /v1/items', base, [{ obs: a, again: null }, { obs: b, again: null }], [{ obs: obs(4, { kind: 'odd', author: 'nobody' }, []), again: null }], statuses(base, a, b));
  assert.ok(!claims.some((c) => /filter_combo/.test(c.claim_key)), JSON.stringify(claims.map((c) => c.statement)));
});
