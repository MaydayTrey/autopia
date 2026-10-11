import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CandidateClaim } from '../../src/worker/claims.js';
import { evidenceCheck, verify } from '../../src/worker/verify.js';
import { ERR, OK_LIST, fakeTrial, resetIds } from '../helpers.js';

function claim(key: string, ids: number[], statuses: (number | null)[], verdict: CandidateClaim['verdict'] = 'observes'): CandidateClaim {
  return {
    claim_key: key,
    statement: `s ${key}`,
    endpoint: 'GET /v1/items',
    kind: 'other',
    param: null,
    verdict,
    source: 'rules',
    confidence: 0.9,
    evidence_trial_ids: ids,
    expectations: ids.map((id, i) => ({ trial_id: id, status: statuses[i] })),
    diverges_from_spec: false,
    spec_says: null,
  };
}

function trials() {
  resetIds();
  return new Map(
    [
      fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: [['q', 'hello']] }),
      fakeTrial({ mutationId: 'required_omitted:q', status: 200, body: OK_LIST, query: [] }),
      fakeTrial({ mutationId: 'enum_invalid:sort', status: 400, body: ERR('invalid_sort', 'sort must be asc or desc'), query: [['q', 'hello'], ['sort', 'zzz']] }),
    ].map((t) => [t.id, t]),
  );
}

test('evidenceCheck: missing trial, unstated expectation, status mismatch, ok', () => {
  const t = trials();
  assert.match(evidenceCheck(claim('a', [99], [200]), t)!, /does not exist/);
  assert.match(evidenceCheck({ ...claim('b', [1], [200]), expectations: [] }, t)!, /no stated expectation/);
  assert.match(evidenceCheck(claim('c', [3], [200]), t)!, /showed status 400, claim says 200/);
  assert.equal(evidenceCheck(claim('d', [1, 3], [200, 400]), t), null);
  assert.match(evidenceCheck(claim('e', [], []), t)!, /no evidence/);
});

const json = (status: number, body: unknown) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => {};

test('verify: claims whose trials reproduce are verified; each trial re-run once', async () => {
  const t = trials();
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    if (url.includes('sort=zzz')) return json(400, ERR('invalid_sort', 'sort must be asc or desc'));
    return json(200, { items: [{ id: 9, name: 'different data, same shape' }], total: 1, page: 1 });
  };
  const r = await verify([claim('a', [1, 2], [200, 200]), claim('b', [1, 3], [200, 400])], t, { fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  assert.equal(r.verified.length, 2);
  assert.equal(r.rejected.length, 0);
  assert.equal(seen.length, 3, 'three distinct trials, each fetched once');
  assert.ok(r.reproductions.every((x) => x.ok));
});

test('verify: a trial that no longer reproduces rejects every claim citing it', async () => {
  const t = trials();
  const fetchImpl = async (url: string) => (url.includes('sort=zzz') ? json(200, OK_LIST) /* behavior changed */ : json(200, OK_LIST));
  const r = await verify([claim('a', [1, 2], [200, 200]), claim('b', [1, 3], [200, 400]), claim('c', [3], [400])], t, { fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  assert.deepEqual(r.verified.map((c) => c.claim_key), ['a']);
  assert.deepEqual(r.rejected.map((x) => x.claim.claim_key).sort(), ['b', 'c']);
  assert.match(r.rejected[0].reason, /reproduction: trial\(s\) 3/);
});

test('verify: error message changes count as non-reproduction', async () => {
  const t = trials();
  const fetchImpl = async (url: string) => (url.includes('sort=zzz') ? json(400, ERR('invalid_sort', 'a DIFFERENT message')) : json(200, OK_LIST));
  const r = await verify([claim('b', [3], [400])], t, { fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  assert.equal(r.verified.length, 0);
});

test('verify: evidence failures never reach reproduction; reproduce=false verifies nothing', async () => {
  const t = trials();
  let fetches = 0;
  const fetchImpl = async () => (fetches++, json(200, OK_LIST));
  const r1 = await verify([claim('bad', [3], [200])], t, { fetchImpl, sleep: noSleep, minIntervalMs: 0 });
  assert.equal(fetches, 0);
  assert.match(r1.rejected[0].reason, /evidence/);
  const r2 = await verify([claim('a', [1], [200])], t, { fetchImpl, sleep: noSleep, reproduce: false });
  assert.equal(r2.verified.length, 0);
  assert.match(r2.rejected[0].reason, /skipped/);
  assert.equal(fetches, 0);
});

test('verify: a transient mismatch is retried once; a persistent one still rejects (500s bypass the executor backoff, so the count is verify alone)', async () => {
  const t = trials();
  let calls = 0;
  const flakyOnce = async () => (++calls === 1 ? json(500, 'upstream hiccup') : json(200, OK_LIST));
  const r1 = await verify([claim('a', [1], [200])], t, { fetchImpl: flakyOnce, sleep: noSleep, minIntervalMs: 0 });
  assert.equal(r1.verified.length, 1, 'second attempt matched the stored signature');
  assert.equal(calls, 2);
  calls = 0;
  const alwaysDifferent = async () => (calls++, json(500, 'down'));
  const r2 = await verify([claim('a', [1], [200])], t, { fetchImpl: alwaysDifferent, sleep: noSleep, minIntervalMs: 0 });
  assert.equal(r2.verified.length, 0);
  assert.equal(calls, 2, 'exactly two attempts, never more');
});
