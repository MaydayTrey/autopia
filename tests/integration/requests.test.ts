/**
 * User-requested targets end to end: a keyed user submits a target (spec
 * served over HTTP by the mock API), scope checks run, the request is stored
 * pending, the worker processes it rules-only, and the tool then exists in
 * the compendium and joins later passes. Also: quota, duplicate names,
 * headers refused, bad specs rejected at submission.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startMockApi, type MockApi } from '../mock-api/server.js';

let dir: string;
let api: MockApi;
let client: typeof import('../../src/db/client.js');
let requests: typeof import('../../src/db/requests.js');
let runner: typeof import('../../src/worker/requests-runner.js');
let keyId: number;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-requests-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  process.env.AUTOPIA_ALLOW_PRIVATE_HOSTS = '1'; // the mock API lives on 127.0.0.1
  client = await import('../../src/db/client.js');
  requests = await import('../../src/db/requests.js');
  runner = await import('../../src/worker/requests-runner.js');
  api = await startMockApi('v1');
  const { createKey } = await import('../../src/db/keys.js');
  keyId = (await createKey(await client.getDb(), 'dana')).row.id;
});

after(async () => {
  await client.closeDb();
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.AUTOPIA_ALLOW_PRIVATE_HOSTS;
});

test('submit: validates scope and the spec, stores the request pending with an inspection note', async () => {
  const db = await client.getDb();
  const r = await requests.submitRequest(db, keyId, { name: 'mock-items', spec_url: api.specUrl, category: 'test', baseline: { '/v1/items': { q: 'hello' } }, rate: { concurrency: 4, min_interval_ms: 0 } });
  assert.equal(r.request.status, 'pending');
  assert.equal(r.inspection.title, 'Mock Items API');
  assert.equal(r.inspection.endpoints, 2);
  assert.ok(r.inspection.trials > 20);
  assert.match(String(r.request.note), /2 endpoint\(s\), \d+ trials planned/);
  const stored = r.request.target as { rate: { concurrency: number; min_interval_ms: number } };
  assert.deepEqual(stored.rate, { concurrency: 1, min_interval_ms: 300 }, 'our politeness caps replace the submitted ones');
});

test('submit: refuses headers, duplicates, unparseable specs, and enforces the daily quota', async () => {
  const db = await client.getDb();
  await assert.rejects(() => requests.submitRequest(db, keyId, { name: 'keyed', spec_url: api.specUrl, headers: { authorization: 'x' } }), /headers are not accepted/);
  await assert.rejects(() => requests.submitRequest(db, keyId, { name: 'mock-items', spec_url: api.specUrl }), /already exists \(status pending/);
  await assert.rejects(() => requests.submitRequest(db, keyId, { name: 'not-a-spec', spec_url: api.url + '/v1/items?q=x' }), /Not an OpenAPI 3/);
  // quota: 3 per day; one stored so far, two more fail at validation and are not counted, so two more succeed then the fourth fails
  await requests.submitRequest(db, keyId, { name: 'second', spec_url: api.specUrl, baseline: { '/v1/items': { q: 'a' } } });
  await requests.submitRequest(db, keyId, { name: 'third', spec_url: api.specUrl, baseline: { '/v1/items': { q: 'a' } } });
  await assert.rejects(() => requests.submitRequest(db, keyId, { name: 'fourth', spec_url: api.specUrl }), /quota: 3 target requests per day/);
  await assert.doesNotReject(() => requests.submitRequest(db, null, { name: 'admin-one', spec_url: api.specUrl, baseline: { '/v1/items': { q: 'a' } } }), 'the admin token has no quota');
});

test('process: pending requests run rules-only, become done with a run id, and the tool exists', async () => {
  const db = await client.getDb();
  const done = await runner.processPendingRequests(db, { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 1 });
  assert.equal(done.length, 4);
  assert.ok(done.every((r) => r.status === 'done'), JSON.stringify(done));
  const first = await requests.getRequest(db, 1);
  assert.equal(first!.status, 'done');
  assert.ok(first!.testRunId);
  assert.match(String(first!.note), /verified/);
  const queries = await import('../../src/db/queries.js');
  const k = await queries.toolKnowledge(db, 'mock-items');
  assert.ok(k && k.claims.length > 10, 'the requested tool is now queryable');
  assert.ok(k!.claims.some((c) => c.diverges_from_spec), 'with the mock\'s planted divergences found');
  const accepted = await requests.acceptedTargets(db);
  assert.deepEqual(accepted.map((t) => t.name).sort(), ['admin-one', 'mock-items', 'second', 'third'], 'accepted targets join later passes');
  assert.equal((await runner.processPendingRequests(db, { llm: null })).length, 0, 'nothing left pending');
});

test('submit: a name already in the compendium is refused with a pointer to the docs', async () => {
  const db = await client.getDb();
  const { createKey } = await import('../../src/db/keys.js');
  const other = (await createKey(db, 'erin')).row.id;
  await assert.rejects(() => requests.submitRequest(db, other, { name: 'mock-items', spec_url: api.specUrl }), /already exists in the compendium/);
});
