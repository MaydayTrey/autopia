import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageDays, ageText, coverageDropped, STALE_DAYS } from '../../src/db/freshness.js';
import { staleNote } from '../../src/db/docs.js';
import type { ClaimView } from '../../src/db/queries.js';

test('ageDays / ageText: whole days, never negative, readable', () => {
  const now = new Date('2026-10-17T12:00:00Z');
  assert.equal(ageDays('2026-10-17T01:00:00Z', now), 0);
  assert.equal(ageDays('2026-10-16T11:00:00Z', now), 1);
  assert.equal(ageDays('2026-10-01T00:00:00Z', now), 16);
  assert.equal(ageDays('2026-10-18T00:00:00Z', now), 0, 'clock skew never goes negative');
  assert.equal(ageDays('2026-10-16T23:30:00Z', new Date('2026-10-17T01:00:00Z')), 1, 'calendar days, not 24h buckets: yesterday late is 1 day ago');
  assert.equal(ageDays('2026-10-14T00:00:00Z', now), 3, 'exactly STALE_DAYS is not yet stale');
  assert.ok(ageDays('2026-10-13T23:59:00Z', now) > STALE_DAYS, 'one more day is');
  assert.equal(ageText(0), 'today');
  assert.equal(ageText(1), '1 day ago');
  assert.equal(ageText(16), '16 days ago');
  assert.equal(STALE_DAYS, 3);
  assert.equal(coverageDropped(5, 108), true);
  assert.equal(coverageDropped(60, 108), false);
  assert.equal(coverageDropped(2, 5), false, 'tiny previous runs do not count');
  assert.equal(coverageDropped(0, null), false);
});

test('staleNote: empty for fresh claims; the oldest age of a group when any is stale', () => {
  const c = (stale_days?: number) => ({ stale_days } as unknown as ClaimView);
  assert.equal(staleNote(c()), '');
  assert.equal(staleNote([c(), c()]), '');
  assert.equal(staleNote(c(20)), ' (last reproduced 20 days ago, not re-run since)');
  assert.equal(staleNote([c(), c(20), c(33)]), ' (last reproduced 33 days ago, not re-run since)');
});
