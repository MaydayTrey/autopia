/**
 * The pagination scenario's pure parts: list detection, item identity, Link parsing, URL -> input,
 * and the invariant checks that turn two walks and a re-read into claims. No network, no DB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityOf, inputFromUrl, listItems, pagingParams, paginationClaims, paginationConfig, parseLinkHeader, type PageObs, type WalkResult } from '../../src/worker/scenarios/pagination.js';
import { listEndpoints } from '../../src/worker/scenarios/index.js';
import { fakeTrial, itemsEndpoint } from '../helpers.js';

test('listItems: a top-level array, an object with one array field (GitHub search), nothing else', () => {
  assert.deepEqual(listItems([{ id: 1 }, { id: 2 }]), { items: [{ id: 1 }, { id: 2 }], field: null, total: null });
  assert.deepEqual(listItems({ total_count: 40, incomplete_results: false, items: [{ id: 7 }] }), { items: [{ id: 7 }], field: 'items', total: 40 });
  assert.deepEqual(listItems([]), { items: [], field: null, total: null });
  assert.equal(listItems({ a: [{ id: 1 }], b: [{ id: 2 }] }), null, 'two array fields: ambiguous');
  assert.equal(listItems({ id: 1, name: 'x' }), null);
  assert.equal(listItems([1, 2, 3]), null, 'an array of primitives is not a list of items');
  assert.equal(listItems('text'), null);
});

test('identityOf: id-like fields in order, else a hash of the item', () => {
  assert.equal(identityOf({ id: 12, sha: 'abc' }), 'id=12');
  assert.equal(identityOf({ sha: 'abc', message: 'm' }), 'sha=abc');
  assert.equal(identityOf({ number: 7 }), 'number=7');
  assert.match(identityOf({ foo: 'bar' }), /^hash=[0-9a-f]{16}$/);
  assert.equal(identityOf({ foo: 'bar' }), identityOf({ foo: 'bar' }), 'stable');
});

test('parseLinkHeader: GitHub-style next/last; empty when absent or malformed', () => {
  const h = '<https://api.github.com/repositories/1/issues?per_page=5&page=2>; rel="next", <https://api.github.com/repositories/1/issues?per_page=5&page=9>; rel="last"';
  assert.deepEqual(parseLinkHeader(h), { next: 'https://api.github.com/repositories/1/issues?per_page=5&page=2', last: 'https://api.github.com/repositories/1/issues?per_page=5&page=9' });
  assert.deepEqual(parseLinkHeader(undefined), {});
  assert.deepEqual(parseLinkHeader('garbage'), {});
  assert.deepEqual(parseLinkHeader('<http://x/?page=2>; rel=next'), { next: 'http://x/?page=2' }, 'unquoted rel');
});

test('inputFromUrl: the Link URL becomes a trial input with the known-good headers; query pairs preserved', () => {
  const like = { method: 'GET' as const, url: 'https://api.github.com/repos/a/b/issues', query: [['per_page', '5'] as [string, string]], headers: { authorization: 'Bearer x', accept: 'application/json' }, pathParams: { owner: 'a', repo: 'b' } };
  const i = inputFromUrl('https://api.github.com/repositories/1/issues?per_page=5&page=2', like);
  assert.equal(i.url, 'https://api.github.com/repositories/1/issues');
  assert.deepEqual(i.query, [['per_page', '5'], ['page', '2']]);
  assert.deepEqual(i.headers, like.headers);
  assert.deepEqual(i.pathParams, like.pathParams);
  assert.throws(() => inputFromUrl('not a url', like));
});

test('pagingParams and paginationConfig: a page number is required; size is optional; the target can tune or disable', () => {
  assert.deepEqual(pagingParams(itemsEndpoint)?.page.name, 'page');
  assert.deepEqual(pagingParams(itemsEndpoint)?.size?.name, 'limit');
  assert.equal(pagingParams({ ...itemsEndpoint, params: itemsEndpoint.params.filter((p) => p.name !== 'page') }), null);
  assert.deepEqual(paginationConfig({ name: 'x', spec_url: 'y' }), { pages: 4, page_size: 5 });
  assert.deepEqual(paginationConfig({ name: 'x', spec_url: 'y', scenarios: { pagination: { pages: 3, page_size: 10 } } }), { pages: 3, page_size: 10 });
  assert.equal(paginationConfig({ name: 'x', spec_url: 'y', scenarios: { pagination: false } }), null);
  assert.deepEqual(paginationConfig({ name: 'x', spec_url: 'y', scenarios: { pagination: { pages: 99, page_size: 0 } } }), { pages: 10, page_size: 1 }, 'clamped');
});

test('listEndpoints: endpoints whose baseline came back as a list (from recorded arrayLengths)', () => {
  const listT = fakeTrial({ mutationId: 'baseline', status: 200, body: { items: [{ id: 1 }], total: 1 }, endpoint: 'GET /v1/items' });
  (listT.response as { arrayLengths?: Record<string, number> }).arrayLengths = { items: 1 };
  const objT = fakeTrial({ mutationId: 'baseline', status: 200, body: { id: 1 }, endpoint: 'GET /v1/items/{id}' });
  (objT.response as { arrayLengths?: Record<string, number> }).arrayLengths = {};
  const eps = [itemsEndpoint, { ...itemsEndpoint, path: '/v1/items/{id}' }];
  assert.deepEqual(listEndpoints(eps, [listT, objT]).map((e) => e.path), ['/v1/items']);
  assert.deepEqual(listEndpoints(eps, [{ ...listT, statusCode: 500 }, objT]), [], 'a failed baseline is not a list');
});

function obs(trialId: number, page: number, ids: (string | number)[], next?: string): PageObs {
  return { trialId, status: 200, page, ids: ids.map((i) => `id=${i}`), link: next ? { next } : {}, isList: true };
}
const statuses = (n: number) => new Map(Array.from({ length: n }, (_, i) => [i + 1, { statusCode: 200 }]));

test('paginationClaims: a clean list yields unique + link + stable + page-size + end claims, each citing its walk', () => {
  const w: WalkResult = {
    byNumber: [obs(1, 1, [1, 2, 3], 'http://x/?page=2'), obs(2, 2, [4, 5, 6], 'http://x/?page=3'), obs(3, 3, [7])],
    byLink: [obs(4, 2, [4, 5, 6], 'http://x/?page=3'), obs(5, 3, [7])],
    again: obs(6, 2, [4, 5, 6]),
    againAfterMs: 2500,
    endSeen: true,
  };
  const claims = paginationClaims('GET /v1/items', 'page', 'limit', 3, w, statuses(6));
  const by = Object.fromEntries(claims.map((c) => [c.claim_key.split(':')[1], c]));
  assert.match(by.pagination_unique.statement, /returns each item once: 7 items, 7 distinct ids, on both a numbered walk and a Link-header walk \(HTTP 200\)/);
  assert.deepEqual(by.pagination_unique.evidence_trial_ids, [1, 2, 3, 4, 5]);
  assert.match(by.pagination_link.statement, /pages 2\.\.3 by Link returned the identical id sequence/);
  assert.match(by.pagination_stable.statement, /read twice 3s apart returned the same 3 ids in the same order/);
  assert.deepEqual(by.pagination_stable.evidence_trial_ids, [2, 6]);
  assert.match(by.pagination_page_size.statement, /limit=3 is honored: pages 1\.\.2 held exactly 3 items each/);
  assert.match(by.pagination_end.statement, /ends at page 3 of limit=3: that page holds 1 item and the Link header stops offering rel="next"/);
  for (const c of claims) {
    assert.equal(c.source, 'scenario');
    assert.equal(c.kind, 'pagination');
    assert.equal(c.param, null);
    assert.ok(c.expectations.every((e) => e.status === 200));
  }
});

test('paginationClaims: duplicates are claimed only when BOTH walks show them; a Link mismatch and an unstable page are named', () => {
  const both: WalkResult = {
    byNumber: [obs(1, 1, [1, 2, 3], 'n2'), obs(2, 2, [3, 4, 5], 'n3'), obs(3, 3, [5, 6, 7])],
    byLink: [obs(4, 2, [3, 4, 5], 'n3'), obs(5, 3, [5, 6, 7])],
    again: obs(6, 2, [4, 5, 6]),
    againAfterMs: 900,
    endSeen: false,
  };
  const c1 = paginationClaims('GET /v1/items', 'page', 'per_page', 3, both, statuses(6));
  const u = c1.find((c) => /pagination_unique/.test(c.claim_key))!;
  assert.match(u.statement, /repeats items across pages: 2 id\(s\) appear on more than one page \(e\.g\. 3 on pages 1 and 2\), in both a numbered walk and a Link-header walk/);
  const st = c1.find((c) => /pagination_stable/.test(c.claim_key))!;
  assert.match(st.statement, /read twice 1s apart differed in 3 of 3 positions/);
  assert.ok(!c1.some((c) => /pagination_end/.test(c.claim_key)), 'no end seen within the budget');

  // Numbered walk repeats, Link walk does not: not reproduced, so no uniqueness claim either way.
  const oneWalk: WalkResult = { ...both, byLink: [obs(4, 2, [4, 5, 6], 'n3'), obs(5, 3, [7, 8, 9])] };
  const c2 = paginationClaims('GET /v1/items', 'page', 'per_page', 3, oneWalk, statuses(6));
  assert.ok(!c2.some((c) => /pagination_unique/.test(c.claim_key)));
  assert.match(c2.find((c) => /pagination_link/.test(c.claim_key))!.statement, /does NOT return the same items as counting "page" up: page\(s\) 2, 3 differ/);

  // No Link header at all while more pages exist.
  const noLink: WalkResult = { byNumber: [obs(1, 1, [1, 2, 3]), obs(2, 2, [4, 5, 6])], byLink: [], again: null, againAfterMs: 0, endSeen: false };
  const c3 = paginationClaims('GET /v1/items', 'page', null, 3, noLink, statuses(2));
  assert.match(c3.find((c) => /pagination_link/.test(c.claim_key))!.statement, /carry no Link header with rel="next" even though more pages exist/);
  assert.match(c3.find((c) => /pagination_unique/.test(c.claim_key))!.statement, /returns each item once: 6 items, 6 distinct ids \(HTTP 200\)/);
  assert.ok(!c3.some((c) => /pagination_page_size/.test(c.claim_key)), 'no size parameter: nothing to honor');

  // The first page was not a list: nothing to say.
  assert.deepEqual(paginationClaims('GET /v1/items', 'page', 'limit', 3, { byNumber: [{ ...obs(1, 1, []), isList: false }], byLink: [], again: null, againAfterMs: 0, endSeen: false }, statuses(1)), []);
});

test('paginationClaims: a list that fits in one page makes no uniqueness, Link or stability claim, only the end', () => {
  // GitHub search for a one-result query: page 1 holds 1 item, page 2 is empty, no Link header anywhere.
  const w: WalkResult = { byNumber: [obs(1, 1, [42]), obs(2, 2, [])], byLink: [], again: obs(3, 2, []), againAfterMs: 3000, endSeen: true };
  const claims = paginationClaims('GET /search/repositories', 'page', 'per_page', 5, w, statuses(3));
  assert.deepEqual(claims.map((c) => c.claim_key.split(':')[1]), ['pagination_end']);
  assert.match(claims[0].statement, /ends at page 1 of per_page=5: page 2 returns an empty list \(HTTP 200\), not an error/);
});
