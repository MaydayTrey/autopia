/**
 * An unreachable target (every request times out) must abort the run after a
 * handful of trials, mark the run failed, and not spend hours timing out
 * through the whole plan. Uses a fetch stub that always times out.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { startMockApi, type MockApi } from '../mock-api/server.js';

let dir: string;
let api: MockApi;
let client: typeof import('../../src/db/client.js');

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-unreach-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'error';
  client = await import('../../src/db/client.js');
  api = await startMockApi('v1'); // only for a parseable spec; requests never reach it
});

after(async () => {
  await client.closeDb();
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('a target whose first trials all time out aborts early and the run is marked failed', async () => {
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  const db = await client.getDb();
  let attempts = 0;
  const timeoutFetch = async () => {
    attempts++;
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const target = validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } });
  await assert.rejects(() => runPipeline(db, target, { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 1, fetchImpl: timeoutFetch, unreachableAfter: 5 }), /target unreachable: the first 5 trials all failed/);
  // 5 trials x (1 + retries) attempts, nowhere near the ~40-trial plan
  assert.ok(attempts >= 5 && attempts <= 5 * 4, `attempts=${attempts}`);
  const { schema } = client;
  const runs = await db.select().from(schema.testRuns);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.match(String((runs[0].stats as { error?: string }).error), /unreachable/);
  const trials = await db.select().from(schema.trials).where(eq(schema.trials.testRunId, runs[0].id));
  assert.equal(trials.length, 5, 'only the probing trials were logged');
  assert.ok(trials.every((t) => t.statusCode === null && t.errorText === 'timeout'));
});
