import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnonLimiter } from '../../src/server/anon-limiter.js';

test('AnonLimiter: per-minute, per-day and global caps, each with a retry-after; windows roll over', () => {
  const l = new AnonLimiter(2, 3, 5);
  let now = 1_000_000;
  assert.deepEqual(l.take('a', now), { ok: true });
  assert.deepEqual(l.take('a', now), { ok: true });
  const third = l.take('a', now);
  assert.equal(third.ok, false);
  assert.match((third as { reason: string }).reason, /rate limit \(2\/min\)/);
  assert.equal((third as { retryAfterSeconds: number }).retryAfterSeconds, 60);
  // Another address has its own minute window.
  assert.deepEqual(l.take('b', now), { ok: true });
  // A minute later 'a' may call again, but its DAY count (3 so far incl. the refused one) is at the limit.
  now += 60_001;
  const day = l.take('a', now);
  assert.equal(day.ok, false);
  assert.match((day as { reason: string }).reason, /daily limit \(3\)/);
  // Global cap: 5 takes have happened (a:4, b:1); the next, from a fresh address, trips it.
  assert.match((l.take('c', now) as { reason: string }).reason ?? '', /capacity for today/);
  // A day later everything resets.
  now += 86_400_001;
  assert.deepEqual(l.take('a', now), { ok: true });
});
