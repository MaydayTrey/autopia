/** The health classifier: which run histories are red, warn, ok, and what they say. No database. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyHealth, formatHealth, type HealthInput } from '../../src/db/health.js';

const now = new Date('2026-10-17T12:00:00Z');
const d = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000);
const run = (id: number, daysAgo: number, claims: number, status = 'finished', error?: string): HealthInput['runs'][number] => ({ id, status, at: d(daysAgo), claims, error });
const codes = (h: ReturnType<typeof classifyHealth>) => h.issues.map((i) => i.code).sort();

test('ok: a scheduled tool refreshed last night with a steady claim count', () => {
  const h = classifyHealth({ tool: 'github-rest', scheduled: true, runs: [run(135, 0, 268), run(119, 1, 268), run(102, 2, 268)] }, now);
  assert.equal(h.level, 'ok');
  assert.deepEqual(h.issues, []);
  assert.equal(h.lastClaimRun?.id, 135);
});

test('red: stale (scheduled, last claims older than 3 days); the same history unscheduled is only a warning', () => {
  const runs = [run(33, 6, 8)];
  const sched = classifyHealth({ tool: 'binance-spot-public', scheduled: true, runs }, now);
  assert.equal(sched.level, 'red');
  assert.deepEqual(codes(sched), ['stale']);
  assert.match(sched.issues[0].detail, /last claims 6 days ago \(run #33 on 2026-10-11\)/);
  const unsched = classifyHealth({ tool: 'binance-spot-public', scheduled: false, runs }, now);
  assert.equal(unsched.level, 'warn');
  assert.deepEqual(codes(unsched), ['stale', 'unscheduled']);
  assert.equal(classifyHealth({ tool: 'x', scheduled: true, runs: [run(1, 3, 10)] }, now).level, 'ok', 'exactly 3 days is not yet stale');
});

test('red: coverage dropped (the open-meteo case); not for tiny previous runs', () => {
  const h = classifyHealth({ tool: 'open-meteo-forecast', scheduled: true, runs: [run(141, 0, 5), run(125, 1, 108), run(110, 2, 108)] }, now);
  assert.equal(h.level, 'red');
  assert.deepEqual(codes(h), ['coverage_dropped']);
  assert.match(h.issues[0].detail, /run #141 on 2026-10-17 kept 5 claims; the best of the previous runs, #125 on 2026-10-16, had 108/);
  assert.equal(classifyHealth({ tool: 'tiny', scheduled: true, runs: [run(2, 0, 2), run(1, 1, 5)] }, now).level, 'ok');
  // Night two of the same problem stays red: the reference is the best of the previous runs, not the thin night before.
  const night2 = classifyHealth({ tool: 'open-meteo-forecast', scheduled: true, runs: [run(150, 0, 5), run(141, 1, 5), run(125, 2, 108), run(110, 3, 108)] }, now);
  assert.equal(night2.level, 'red');
  assert.match(night2.issues[0].detail, /#150 on 2026-10-17 kept 5 claims; the best of the previous runs, #125 on 2026-10-15, had 108/);
  // A finished run that stored nothing is a drop to zero, not an invisible night.
  const zero = classifyHealth({ tool: 'z', scheduled: true, runs: [run(9, 0, 0), run(8, 1, 100)] }, now);
  assert.deepEqual(codes(zero), ['coverage_dropped']);
  assert.match(zero.issues[0].detail, /run #9 on 2026-10-17 stored no claims; the best of the previous runs, #8 on 2026-10-16, had 100/);
});

test('failures: one failed night warns and names the standing claims; three in a row is red; a failed run between producing runs does not hide a drop', () => {
  const once = classifyHealth({ tool: 'frankfurter', scheduled: true, runs: [run(117, 0, 0, 'failed', 'The operation was aborted due to timeout'), run(102, 1, 115)] }, now);
  assert.equal(once.level, 'warn');
  assert.deepEqual(codes(once), ['failed_once']);
  assert.match(once.issues[0].detail, /latest run #117 on 2026-10-17 failed \(The operation was aborted due to timeout\); claims from run #102 on 2026-10-16 stand/);
  const three = classifyHealth({ tool: 'x', scheduled: true, runs: [run(5, 0, 0, 'failed', 'boom'), run(4, 1, 0, 'failed', 'boom'), run(3, 2, 0, 'failed', 'boom'), run(2, 3, 50)] }, now);
  assert.equal(three.level, 'red');
  assert.deepEqual(codes(three), ['failing']);
  const gap = classifyHealth({ tool: 'y', scheduled: true, runs: [run(9, 0, 4), run(8, 1, 0, 'failed'), run(7, 2, 100)] }, now);
  assert.deepEqual(codes(gap), ['coverage_dropped'], 'the previous PRODUCING run is the reference');
});

test('never produced: warn, with the last error when there is one; no runs at all also warns', () => {
  const jikan = classifyHealth({ tool: 'jikan', scheduled: false, runs: [run(36, 6, 0), run(31, 6, 0, 'failed', 'worker exited before finishing')] }, now);
  assert.equal(jikan.level, 'warn');
  assert.deepEqual(codes(jikan), ['never_produced', 'unscheduled']);
  assert.deepEqual(codes(classifyHealth({ tool: 'new', scheduled: true, runs: [] }, now)), ['never_produced']);
  assert.equal(classifyHealth({ tool: 'new', scheduled: true, runs: [run(3, 0, 0), run(2, 1, 0), run(1, 2, 0)] }, now).level, 'red', 'three empty runs of a scheduled tool is red');
  assert.equal(classifyHealth({ tool: 'new', scheduled: true, runs: [run(2, 0, 0), run(1, 1, 0)] }, now).level, 'warn', 'two is still a warning');
});

test('formatHealth: worst first, one line per tool with an issue; the all-clear line otherwise', () => {
  const rows = [
    classifyHealth({ tool: 'github-rest', scheduled: true, runs: [run(1, 0, 268)] }, now),
    classifyHealth({ tool: 'binance-spot-public', scheduled: false, runs: [run(33, 6, 8)] }, now),
    classifyHealth({ tool: 'open-meteo-forecast', scheduled: true, runs: [run(141, 0, 5), run(125, 1, 108)] }, now),
  ];
  const lines = formatHealth(rows);
  assert.equal(lines[0], 'HEALTH: 1 red, 1 warn, 1 ok');
  assert.match(lines[1], /^  RED  open-meteo-forecast\s+coverage_dropped: run #141 on 2026-10-17 kept 5 claims; the best of the previous runs, #125 on 2026-10-16, had 108$/);
  assert.match(lines[2], /^  WARN binance-spot-public\s+unscheduled: .*; stale: last claims 6 days ago/);
  assert.match(lines[3], /Re-run one: npm run autopia -- run targets\/<name>\.json/);
  assert.deepEqual(formatHealth([rows[0]]), ['HEALTH: all 1 tool(s) ok']);
});
