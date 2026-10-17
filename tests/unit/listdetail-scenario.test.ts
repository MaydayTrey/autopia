/**
 * The list-vs-detail scenario's pure parts: finding the detail endpoint in the spec, choosing the
 * item field that feeds its path parameter, comparing an item to its detail, and the claims.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareItemToDetail, detailEndpointFor, idFieldsFor, idValueFor, isPathSegment, listDetailClaims, type Comparison } from '../../src/worker/scenarios/listdetail.js';
import { itemsEndpoint } from '../helpers.js';
import type { EndpointSpec } from '../../src/worker/spec.js';

const detailEp: EndpointSpec = { ...itemsEndpoint, path: '/v1/items/{id}', params: [{ name: 'id', in: 'path', required: true, type: 'integer', explode: false }] };
const issues: EndpointSpec = { ...itemsEndpoint, path: '/repos/{owner}/{repo}/issues', params: [] };
const issue: EndpointSpec = { ...itemsEndpoint, path: '/repos/{owner}/{repo}/issues/{issue_number}', params: [{ name: 'issue_number', in: 'path', required: true, type: 'integer', explode: false }] };
const comments: EndpointSpec = { ...itemsEndpoint, path: '/repos/{owner}/{repo}/issues/{issue_number}/comments', params: [] };

test('detailEndpointFor: the list path plus exactly one template segment, GET, with a matching path param', () => {
  assert.equal(detailEndpointFor(itemsEndpoint, [itemsEndpoint, detailEp])?.param.name, 'id');
  assert.equal(detailEndpointFor(issues, [issues, issue, comments])?.ep.path, '/repos/{owner}/{repo}/issues/{issue_number}');
  assert.equal(detailEndpointFor(issues, [issues, comments]), null, 'two extra segments is not a detail');
  assert.equal(detailEndpointFor(itemsEndpoint, [itemsEndpoint]), null);
});

test('idFieldsFor / idValueFor: the parameter name picks the item field', () => {
  assert.deepEqual(idFieldsFor('issue_number'), ['number', 'id']);
  assert.deepEqual(idFieldsFor('ref'), ['sha', 'id']);
  assert.deepEqual(idFieldsFor('release_id'), ['id', 'number']);
  assert.deepEqual(idFieldsFor('key_id'), ['id', 'number'], 'an id-suffixed name is an id before it is a key');
  assert.deepEqual(idFieldsFor('username'), ['login', 'name', 'slug', 'key', 'id']);
  assert.deepEqual(idValueFor({ id: 9, number: 42 }, 'issue_number'), { field: 'number', value: '42' });
  assert.deepEqual(idValueFor({ sha: 'abc', id: 1 }, 'ref'), { field: 'sha', value: 'abc' });
  assert.deepEqual(idValueFor({ login: 'octocat' }, 'username'), { field: 'login', value: 'octocat' });
  assert.equal(idValueFor({ title: 'x' }, 'issue_number'), null);
  // Values that feed a path segment: one plain bounded segment only.
  for (const ok of ['42', 'abc123', 'octocat', 'v1.2.3', 'a-b_c']) assert.equal(isPathSegment(ok), true, ok);
  for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a?b', 'a#b', 'a b', 'x'.repeat(201)]) assert.equal(isPathSegment(bad), false, JSON.stringify(bad));
});

test('compareItemToDetail: added, missing, differing scalars, identity', () => {
  const c = compareItemToDetail({ id: 1, name: 'a', q: 'hello', tag: 'none', labels: [1] }, { id: 1, name: 'A', description: 'd', labels: [1, 2] }, 'id');
  assert.deepEqual(c, { identityAgrees: true, added: ['description'], missing: ['q', 'tag'], differing: ['labels', 'name'] }, 'nested values are compared too');
  assert.equal(compareItemToDetail({ id: 1 }, { id: 2 }, 'id').identityAgrees, false);
  assert.deepEqual(compareItemToDetail({ id: 1, n: null }, { id: 1, n: null }, 'id').differing, [], 'null equals null');
});

const comp = (trialId: number, p: Partial<Comparison> = {}): Comparison => ({ trialId, status: 200, identityAgrees: true, added: [], missing: [], differing: [], ...p });
const statuses = (ids: number[]) => new Map(ids.map((id) => [id, { statusCode: 200 }]));

test('listDetailClaims: only facts true for BOTH items; wording for each combination; nothing without two confirmed reads', () => {
  const two = [comp(2, { added: ['description', 'stats'], missing: ['q'], differing: ['name', 'updated_at'] }), comp(3, { added: ['description'], missing: ['q', 'tag'], differing: ['name'] })];
  const claims = listDetailClaims('GET /v1/items', 'GET /v1/items/{id}', 1, 200, two, statuses([1, 2, 3]));
  const by = Object.fromEntries(claims.map((c) => [c.claim_key.split(':')[1], c]));
  assert.match(by.list_detail_fields.statement, /^The detail endpoint GET \/v1\/items\/\{id\} returns top-level fields the list items omit: description; the list items carry top-level fields the detail omits: q \(two items, list and detail both HTTP 200\)\./);
  assert.match(by.list_detail_values.statement, /value or type differs between a list item and its detail read seconds later: name \(on both items, list and detail both HTTP 200\)/);
  assert.deepEqual(by.list_detail_fields.evidence_trial_ids, [1, 2, 3]);
  assert.equal(by.list_detail_fields.endpoint, 'GET /v1/items', 'claims attach to the list endpoint');
  const same = listDetailClaims('GET /v1/items', 'GET /v1/items/{id}', 1, 200, [comp(2), comp(3)], statuses([1, 2, 3]));
  assert.match(same[0].statement, /adds no top-level field beyond the list item \(two items, list and detail both HTTP 200\): a second request adds no field/);
  assert.match(same[1].statement, /every field shared by the list item and its detail had the same value, nested contents included/);
  // A difference on ONE item only earns no claim either way: neither the finding nor its negation is supported.
  const mixed = listDetailClaims('GET /x', 'GET /x/{id}', 1, 200, [comp(2, { added: ['body'], differing: ['name'] }), comp(3)], statuses([1, 2, 3]));
  assert.deepEqual(mixed, []);
  const addsOnly = listDetailClaims('GET /x', 'GET /x/{id}', 1, 200, [comp(2, { added: ['body'] }), comp(3, { added: ['body'] })], statuses([1, 2, 3]));
  assert.match(addsOnly[0].statement, /returns top-level fields the list items omit: body \(two items, list and detail both HTTP 200\)\. Fetch the detail only for those/);
  const missingOnly = listDetailClaims('GET /x', 'GET /x/{id}', 1, 200, [comp(2, { missing: ['tag'] }), comp(3, { missing: ['tag'] })], statuses([1, 2, 3]));
  assert.match(missingOnly[0].statement, /adds no top-level field beyond the list item and omits tag that the list items carry/);
  // One detail failed, or its identity did not match the item: nothing is claimed.
  assert.deepEqual(listDetailClaims('GET /x', 'GET /x/{id}', 1, 200, [comp(2), comp(3, { status: 404 })], statuses([1, 2, 3])), []);
  assert.deepEqual(listDetailClaims('GET /x', 'GET /x/{id}', 1, 200, [comp(2), comp(3, { identityAgrees: false })], statuses([1, 2, 3])), []);
  // Long field lists are capped by name.
  const many = Array.from({ length: 15 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const capped = listDetailClaims('GET /x', 'GET /x/{id}', 1, 200, [comp(2, { added: many }), comp(3, { added: many })], statuses([1, 2, 3]));
  assert.match(capped[0].statement, /f00, f01, .*f11 \(3 more\)/);
});
