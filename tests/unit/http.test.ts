import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUrl, execute, hashInput, parseBody, truncateBody, type TrialInput } from '../../src/worker/http.js';

const base: TrialInput = { method: 'GET', url: 'http://x/v1/items', query: [['q', 'a b'], ['q', 'c&d']], headers: {} };

test('buildUrl encodes and preserves order and duplicates', () => {
  assert.equal(buildUrl(base), 'http://x/v1/items?q=a%20b&q=c%26d');
  assert.equal(buildUrl({ ...base, query: [] }), 'http://x/v1/items');
});

test('hashInput: stable, order-sensitive on query, order-insensitive on header keys', () => {
  assert.equal(hashInput(base), hashInput({ ...base, query: [['q', 'a b'], ['q', 'c&d']] }));
  assert.notEqual(hashInput(base), hashInput({ ...base, query: [['q', 'c&d'], ['q', 'a b']] }));
  assert.equal(hashInput({ ...base, headers: { a: '1', b: '2' } }), hashInput({ ...base, headers: { b: '2', a: '1' } }));
  assert.notEqual(hashInput(base), hashInput({ ...base, method: 'HEAD' }));
});

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const noSleep = async () => {};

test('execute: 200 JSON -> parsed body, signature, kept headers', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const out = await execute(base, { fetchImpl: async (url, init) => (calls.push({ url, init }), json(200, { items: [1] }, { 'x-ignored': '1', 'cache-control': 'no-cache' })), sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://x/v1/items?q=a%20b&q=c%26d');
  assert.match(String((calls[0].init.headers as Record<string, string>)['user-agent']), /autopia/);
  assert.equal(out.status, 200);
  assert.equal(out.bodyKind, 'json');
  assert.deepEqual(out.body, { items: [1] });
  assert.deepEqual(out.headers, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
  assert.deepEqual(out.signature.shape, { items: ['array', 'number'] });
  assert.equal(out.rateLimited, false);
});

test('execute: 429 then 200 -> retried, marked rateLimited', async () => {
  let n = 0;
  const out = await execute(base, { fetchImpl: async () => (n++ === 0 ? json(429, { reason: 'slow down' }, { 'retry-after': '1' }) : json(200, { ok: true })), sleep: noSleep, retries: 3 });
  assert.equal(n, 2);
  assert.equal(out.status, 200);
  assert.equal(out.rateLimited, true);
});

test('execute: persistent 429 -> final 429 outcome after retries', async () => {
  let n = 0;
  const out = await execute(base, { fetchImpl: async () => (n++, json(429, { reason: 'slow down' })), sleep: noSleep, retries: 2 });
  assert.equal(n, 3);
  assert.equal(out.status, 429);
  assert.equal(out.rateLimited, true);
  assert.equal(out.signature.errorMessage, 'slow down');
});

test('execute: timeout -> transport error after retries, status null', async () => {
  let n = 0;
  const out = await execute(base, {
    fetchImpl: async () => {
      n++;
      const e = new Error('The operation was aborted due to timeout');
      e.name = 'TimeoutError';
      throw e;
    },
    sleep: noSleep,
    retries: 1,
  });
  assert.equal(n, 2);
  assert.equal(out.status, null);
  assert.equal(out.transportError, 'timeout');
  assert.equal(out.signature.bodyKind, 'none');
});

test('execute: HEAD does not read a body', async () => {
  const out = await execute({ ...base, method: 'HEAD' }, { fetchImpl: async () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }), sleep: noSleep });
  assert.equal(out.status, 200);
  assert.equal(out.bodyKind, 'empty');
});

test('parseBody and truncateBody', () => {
  assert.deepEqual(parseBody('{"a":1}', 'text/plain'), { bodyKind: 'json', body: { a: 1 } }); // sniffed
  assert.deepEqual(parseBody('<xml/>', 'application/xml'), { bodyKind: 'text', body: '<xml/>' });
  assert.deepEqual(parseBody('', 'application/json'), { bodyKind: 'empty', body: null });
  assert.deepEqual(parseBody('{not json', 'application/json'), { bodyKind: 'text', body: '{not json' });
  const t = truncateBody({ s: 'x'.repeat(300), arr: [1, 2, 3, 4, 5, 6, 7] }) as { s: string; arr: unknown[] };
  assert.equal(t.s.length < 230, true);
  assert.equal(t.arr.length, 6);
  assert.equal(t.arr[5], '…(+2 more)');
});
