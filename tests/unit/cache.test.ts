import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memo, memoClear, memoSize } from '../../src/db/cache.js';

test('memo: one computation per key within the TTL, concurrent misses share it, failures are not cached', async () => {
  memoClear();
  let calls = 0;
  const f = () => memo('k', async () => ++calls, 50);
  const [a, b] = await Promise.all([f(), f()]);
  assert.equal(a, 1);
  assert.equal(b, 1, 'the second concurrent miss shared the first computation');
  assert.equal(await f(), 1, 'hit');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await f(), 2, 'recomputed after the TTL');
  let n = 0;
  const failing = () => memo('bad', async () => { if (++n === 1) throw new Error('boom'); return n; }, 1000);
  await assert.rejects(failing, /boom/);
  assert.equal(await failing(), 2, 'a failure was not cached');
  assert.ok(memoSize() >= 2);
  memoClear();
  assert.equal(memoSize(), 0);
});
