/**
 * Cost controls end to end on the mock API:
 *   1. a run WITH a (fake) LLM stores an LLM claim
 *   2. a rules-only run carries that claim forward, remapped to its own trials, re-verified
 *   3. a carried claim whose behavior changed is dropped (via the v2 server on the same version)
 *   4. pruning keeps the latest run per version and anything young, deletes the rest
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { FakeLlm } from '../../src/llm/adapter.js';
import { pruneRuns } from '../../src/db/retention.js';
import { startMockApi, type MockApi } from '../mock-api/server.js';

let dir: string;
let api: MockApi;
let client: typeof import('../../src/db/client.js');
let pipeline: typeof import('../../src/worker/pipeline.js');
let db: Awaited<ReturnType<typeof import('../../src/db/client.js').getDb>>;
let target: import('../../src/worker/target.js').TargetConfig;
const fast = { sleep: async () => {}, minIntervalMs: 0, concurrency: 1 };

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-retention-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  client = await import('../../src/db/client.js');
  pipeline = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  api = await startMockApi('v1');
  target = validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } });
  db = await client.getDb();
});

after(async () => {
  await client.closeDb();
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function llmClaimsOfLatestRun(toolVersionId: number) {
  const { schema } = client;
  const { latestClaimsForVersion } = await import('../../src/worker/diff.js');
  const cur = await latestClaimsForVersion(db, toolVersionId);
  return (cur?.claims ?? []).filter((c) => c.source === 'llm').map((c) => ({ key: c.claimKey, run: c.testRunId, evidence: c.evidenceTrialIds, schema }));
}

test('an LLM claim survives rules-only runs by carry-forward, remapped to fresh trials', async () => {
  // run 1: rules only, so we know the plan order and can compute trial ids for the fake LLM in run 2
  const r1 = await pipeline.runPipeline(db, target, { ...fast, llm: null });
  assert.equal(r1.candidates.carried, 0);
  const { max } = await import('drizzle-orm');
  const { schema } = client;
  const [{ m }] = await db.select({ m: max(schema.trials.id) }).from(schema.trials);
  const { planAll } = await import('../../src/worker/exercise.js');
  const { extractEndpoints, fetchSpecText, parseSpecText } = await import('../../src/worker/spec.js');
  const plan = planAll(extractEndpoints(parseSpecText(await fetchSpecText(target.spec_url))).endpoints, target, 500);
  const idOf = (mutationId: string) => Number(m) + 1 + plan.findIndex((t) => t.id === mutationId && t.endpoint === 'GET /v1/items');
  const fake = new FakeLlm([
    JSON.stringify({ claims: [{ statement: 'HEAD on /v1/items returns 200 like GET, with no body.', endpoint: 'GET /v1/items', kind: 'undocumented', param: null, verdict: 'observes', evidence: [{ trial_id: idOf('baseline'), status: 200 }, { trial_id: idOf('method_head'), status: 200 }], confidence: 0.8, diverges_from_spec: false, spec_says: null }] }),
  ]);
  // run 2: with the fake LLM -> one LLM claim stored
  const r2 = await pipeline.runPipeline(db, target, { ...fast, llm: fake });
  assert.equal(r2.candidates.llm, 1);
  const after2 = await llmClaimsOfLatestRun(r2.toolVersionId);
  assert.equal(after2.length, 1);
  assert.equal(after2[0].run, r2.testRunId);

  // run 3: rules only -> the LLM claim is carried, with NEW trial ids, and verified again
  const r3 = await pipeline.runPipeline(db, target, { ...fast, llm: null });
  assert.equal(r3.candidates.carried, 1);
  assert.equal(r3.candidates.carriedDropped, 0);
  assert.equal(r3.rejected.length, 0);
  const after3 = await llmClaimsOfLatestRun(r3.toolVersionId);
  assert.equal(after3.length, 1);
  assert.equal(after3[0].key, after2[0].key, 'same claim_key');
  assert.equal(after3[0].run, r3.testRunId, 'now belongs to the rules-only run');
  assert.notDeepEqual(after3[0].evidence, after2[0].evidence, 'evidence remapped to run 3 trials');
  const trials = await db.select().from(schema.trials).where(eq(schema.trials.testRunId, r3.testRunId));
  assert.ok(after3[0].evidence.every((id) => trials.some((t) => t.id === id)), 'cited trials exist in run 3');

  // run 4: with the LLM again, returning nothing -> the carried claim still persists (fresh LLM wins ties, carry fills gaps)
  const r4 = await pipeline.runPipeline(db, target, { ...fast, llm: new FakeLlm(['{"claims":[]}']) });
  assert.equal(r4.candidates.carried, 1);
  assert.equal((await llmClaimsOfLatestRun(r4.toolVersionId)).length, 1);
});

test('a carried claim whose behavior changed is dropped by the evidence check', async () => {
  // Point the SAME spec hash at a v2 server by swapping the mock behind the same spec path is not
  // possible (the spec embeds the URL), so emulate the change: rewrite the stored expectation.
  const { schema } = client;
  const { latestClaimsForVersion } = await import('../../src/worker/diff.js');
  const toolVersionId = (await db.select().from(schema.toolVersions))[0].id;
  const cur = await latestClaimsForVersion(db, toolVersionId);
  const llm = cur!.claims.find((c) => c.source === 'llm')!;
  await db.update(schema.claims).set({ expectations: (llm.expectations as { trial_id: number; status: number }[]).map((e) => ({ ...e, status: 503 })) }).where(eq(schema.claims.id, llm.id));
  const r = await pipeline.runPipeline(db, target, { ...fast, llm: null });
  assert.equal(r.candidates.carried, 1, 'it was remapped');
  assert.ok(r.rejected.some((x) => x.claim.claim_key === llm.claimKey && /evidence/.test(x.reason)), 'and then rejected because tonight\'s status is not 503');
  assert.equal((await llmClaimsOfLatestRun(toolVersionId)).length, 0);
});

test('pruneRuns keeps the latest finished run per version and young runs; deletes the rest', async () => {
  const { schema } = client;
  const runsBefore = await db.select().from(schema.testRuns).orderBy(schema.testRuns.id);
  assert.ok(runsBefore.length >= 5);
  // nothing is older than 14 days yet
  const dry = await pruneRuns(db, { keepDays: 14, dryRun: true });
  assert.equal(dry.runsDeleted, 0);
  // pretend everything is old: keepDays 0 with "now" in the future
  const future = new Date(Date.now() + 60_000);
  const plan = await pruneRuns(db, { keepDays: 0, now: future, dryRun: true });
  assert.equal(plan.runsDeleted, runsBefore.length - 1, 'all but the latest run of the single version');
  assert.ok(plan.trialsDeleted > 100);
  const done = await pruneRuns(db, { keepDays: 0, now: future });
  assert.equal(done.runsDeleted, plan.runsDeleted);
  const runsAfter = await db.select().from(schema.testRuns);
  assert.equal(runsAfter.length, 1);
  assert.equal(runsAfter[0].id, runsBefore[runsBefore.length - 1].id);
  const orphanTrials = await db.select().from(schema.trials).where(eq(schema.trials.testRunId, runsBefore[0].id));
  assert.equal(orphanTrials.length, 0);
  // the surviving run's claims still have their evidence
  const queries = await import('../../src/db/queries.js');
  const k = await queries.toolKnowledge(db, 'mock-items');
  assert.ok(k!.claims.length > 10 && k!.claims.every((c) => c.evidence.length >= 1));
});
