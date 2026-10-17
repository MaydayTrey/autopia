/**
 * End-to-end: the real pipeline (discover -> exercise -> aggregate -> cross-ref
 * -> verify -> write -> diff) against the mock API, on a throwaway PGlite dir.
 * Asserts the five success criteria from docs/compendium-spec.txt section 12
 * as far as they can be checked offline.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { FakeLlm } from '../../src/llm/adapter.js';
import { startMockApi, type MockApi } from '../mock-api/server.js';

let dir: string;
let api: MockApi;
let db: Awaited<ReturnType<typeof import('../../src/db/client.js').getDb>>;
let client: typeof import('../../src/db/client.js');
let pipeline: typeof import('../../src/worker/pipeline.js');
let queries: typeof import('../../src/db/queries.js');
let target: import('../../src/worker/target.js').TargetConfig;

const fast = { sleep: async () => {}, minIntervalMs: 0, concurrency: 4 };

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-it-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  client = await import('../../src/db/client.js');
  pipeline = await import('../../src/worker/pipeline.js');
  queries = await import('../../src/db/queries.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  api = await startMockApi('v1');
  target = validateTarget({ name: 'mock-items', category: 'test', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } });
  db = await client.getDb();
});

after(async () => {
  await client.closeDb();
  await api.close();
  await rm(dir, { recursive: true, force: true });
});

test('run 1: finds the planted divergences, stores only verified claims', async () => {
  const s = await pipeline.runPipeline(db, target, { ...fast, llm: null });
  assert.equal(s.isNewVersion, true);
  assert.ok(s.trials > 30, `trials ${s.trials}`);
  assert.equal(s.rejected.length, 0, JSON.stringify(s.rejected.map((r) => r.reason)));
  assert.ok(s.verified.length > 10);
  const keys = new Set(s.verified.filter((c) => c.divergenceType === 'spec').map((c) => c.claimKey));
  for (const k of ['rule:required_omitted:get_v1_items:q', 'rule:wrong_type:get_v1_items:limit', 'rule:boundary_above_max:get_v1_items:limit']) assert.ok(keys.has(k), `expected divergence ${k}; got ${[...keys].join(', ')}`);
  assert.ok(!keys.has('rule:enum_invalid:get_v1_items:sort'), 'enum is enforced, not a divergence');

  // every stored claim is verified and its evidence exists
  const { schema } = client;
  const stored = await db.select().from(schema.claims).where(eq(schema.claims.testRunId, s.testRunId));
  assert.equal(stored.length, s.verified.length);
  assert.ok(stored.every((c) => c.verified));
  const ids = [...new Set(stored.flatMap((c) => c.evidenceTrialIds))];
  const trials = await queries.trialsByIds(db, ids);
  assert.equal(trials.size, ids.length);

  // the second endpoint (path param) was exercised too
  assert.ok(stored.some((c) => c.endpoint === 'GET /v1/items/{id}'));
  // Scenario battery: pagination completeness ran on the list endpoint; its claims are verified like any other.
  assert.equal(s.scenarios.endpoints.length, 1, JSON.stringify(s.scenarios));
  assert.ok(s.scenarios.requests >= 6 && s.scenarios.requests <= 8, `scenario requests ${s.scenarios.requests}`);
  const scen = stored.filter((c) => c.source === 'scenario');
  const statements = JSON.stringify(scen.map((c) => [c.claimKey, c.statement]));
  assert.ok(scen.some((c) => c.claimKey === 'scenario:pagination_unique:get_v1_items:-' && /returns each item once: 7 items, 7 distinct ids, on both a numbered walk and a Link-header walk/.test(c.statement)), statements);
  assert.ok(scen.some((c) => c.claimKey === 'scenario:pagination_link:get_v1_items:-' && /identical id sequence/.test(c.statement)), statements);
  assert.ok(scen.some((c) => c.claimKey === 'scenario:pagination_stable:get_v1_items:-' && /same order/.test(c.statement)), statements);
  assert.ok(scen.some((c) => c.claimKey === 'scenario:pagination_page_size:get_v1_items:-' && /limit=5 is not what comes back: pages 1\.\.2 held 3 items/.test(c.statement)), 'the planted clamp shows up as a page-size finding: ' + statements);
  assert.ok(scen.some((c) => c.claimKey === 'scenario:pagination_end:get_v1_items:-' && /ends at page 3/.test(c.statement)), statements);
  assert.ok(scen.every((c) => c.kind === 'pagination' && c.verified && c.evidenceTrialIds.length >= 1));
  // Scenario trials are logged like any other and cited by the claims.
  const scenTrials = await db.select().from(schema.trials).where(eq(schema.trials.testRunId, s.testRunId));
  assert.ok(scenTrials.filter((t) => t.mutationType === 'scenario').length === s.scenarios.requests);
  // politeness: we identified ourselves
  assert.ok(api.requests.length >= s.trials);
});

test('run 2 on the unchanged spec: same version, identical claim set (determinism)', async () => {
  const s = await pipeline.runPipeline(db, target, { ...fast, llm: null });
  assert.equal(s.isNewVersion, false);
  const runs = await queries.runsForTool(db, s.toolId);
  assert.equal(runs.length, 2);
  const { schema } = client;
  const keys = async (runId: number) => (await db.select({ k: schema.claims.claimKey }).from(schema.claims).where(eq(schema.claims.testRunId, runId))).map((r) => r.k).sort();
  assert.deepEqual(await keys(runs[0].id), await keys(runs[1].id));
  assert.equal(s.diff, null, 'same version: no version diff');
});

test('LLM pass: valid claims kept, invalid/unknown-evidence ones discarded, tokens recorded', async () => {
  // The fake LLM must cite trial ids that will exist in the NEXT run. Ids are allocated
  // sequentially after the current max, and with concurrency 1 trials are inserted in
  // plan order, so plan index + next id gives the id of a given probe.
  const { schema } = client;
  const { max } = await import('drizzle-orm');
  const [{ m }] = await db.select({ m: max(schema.trials.id) }).from(schema.trials);
  const nextFirstId = Number(m) + 1;
  const { planAll } = await import('../../src/worker/exercise.js');
  const { extractEndpoints, fetchSpecText, parseSpecText } = await import('../../src/worker/spec.js');
  const plan = planAll(extractEndpoints(parseSpecText(await fetchSpecText(target.spec_url))).endpoints, target, 500);
  const offsetOf = (mutationId: string) => plan.findIndex((t) => t.id === mutationId && t.endpoint === 'GET /v1/items');
  const baselineId = nextFirstId + offsetOf('baseline');
  const headId = nextFirstId + offsetOf('method_head');
  const fake = new FakeLlm([
    JSON.stringify({
      claims: [
        { statement: 'HEAD on /v1/items returns 200 with no body, mirroring GET status.', endpoint: 'GET /v1/items', kind: 'undocumented', param: null, verdict: 'observes', evidence: [{ trial_id: baselineId, status: 200 }, { trial_id: headId, status: 200 }], confidence: 0.8, diverges_from_spec: false, spec_says: null },
        { statement: 'Cites a trial that does not exist so must be discarded.', endpoint: 'GET /v1/items', kind: 'other', param: null, verdict: 'observes', evidence: [{ trial_id: 999999, status: 200 }], confidence: 0.5, diverges_from_spec: false, spec_says: null },
        { statement: 'Wrong status for the baseline trial, fails the evidence check.', endpoint: 'GET /v1/items', kind: 'other', param: null, verdict: 'observes', evidence: [{ trial_id: baselineId, status: 500 }], confidence: 0.5, diverges_from_spec: false, spec_says: null },
        { statement: 'missing fields', kind: 'other' },
      ],
    }),
  ]);
  // Note: trial ordering inside a run is by completion, so offsets can differ with concurrency > 1; use concurrency 1 here.
  const s = await pipeline.runPipeline(db, target, { ...fast, concurrency: 1, llm: fake });
  assert.equal(fake.requests.length, 1);
  assert.match(fake.requests[0].user, /Documented parameters/);
  assert.match(fake.requests[0].user, /Already claimed by rules/);
  assert.equal(s.candidates.llmDiscarded, 2, 'unknown trial id + schema failure discarded at aggregate');
  assert.equal(s.candidates.llm, 2);
  assert.equal(s.rejected.length, 1, 'wrong-status claim rejected by the evidence check');
  assert.match(s.rejected[0].reason, /evidence/);
  const llmStored = s.verified.filter((c) => c.source === 'llm');
  assert.equal(llmStored.length, 1);
  assert.match(llmStored[0].statement, /HEAD on \/v1\/items/);
  assert.ok(llmStored[0].claimKey.startsWith('llm:undocumented:get_v1_items:-:observes:baseline+method_head'));
  const run = (await queries.runsForTool(db, s.toolId))[0];
  assert.equal(run.llmModel, 'fake');
  assert.ok(run.llmInputTokens > 0);
});

test('new spec version: new tool_version, diff shows changed behavior', async () => {
  const api2 = await startMockApi('v2');
  try {
    const t2 = { ...target, spec_url: api2.specPath };
    const s = await pipeline.runPipeline(db, t2, { ...fast, llm: null });
    assert.equal(s.isNewVersion, true);
    assert.ok(s.diff, 'diff computed against version 1');
    const changes = Object.fromEntries(s.diff!.entries.map((e) => [e.claimKey, e.changeType]));
    assert.equal(changes['rule:required_omitted:get_v1_items:q'], 'changed'); // now enforced
    assert.equal(changes['rule:wrong_type:get_v1_items:limit'], 'changed');
    assert.equal(changes['rule:boundary_above_max:get_v1_items:limit'], 'changed');
    assert.equal(changes['rule:extra_field:get_v1_items:-'], 'changed');
    assert.equal(changes['rule:enum_invalid:get_v1_items:sort'], 'unchanged');
    assert.ok(s.diff!.counts.unchanged > 5);
    // divergences disappeared in v2 for those keys
    const div = new Set(s.verified.filter((c) => c.divergenceType).map((c) => c.claimKey));
    assert.ok(!div.has('rule:required_omitted:get_v1_items:q'));

    const vd = await queries.versionDiff(db, 'mock-items', s.diff!.fromVersionId, s.toolVersionId);
    assert.ok(vd);
    assert.equal(vd!.counts.changed, s.diff!.counts.changed);
    assert.ok(vd!.changes.some((c) => c.claim_key === 'rule:required_omitted:get_v1_items:q' && c.before?.verdict === 'accepts' && c.after?.verdict === 'rejects'));
  } finally {
    await api2.close();
  }
});

test('queries: tool knowledge, divergences, search', async () => {
  const k = await queries.toolKnowledge(db, 'mock-items');
  assert.ok(k && k.version && k.claims.length > 0);
  assert.ok(k!.claims.every((c) => c.evidence.length >= 1 && c.evidence.every((e) => typeof e.request.url === 'string')));
  assert.ok(Object.keys(k!.by_kind).includes('error_behavior'));
  const d = await queries.toolKnowledge(db, 'mock-items', null, true);
  assert.ok(d!.claims.every((c) => c.diverges_from_spec));
  const hits = await queries.searchClaims(db, 'unknown query parameters', 'mock-items');
  assert.ok(hits.length >= 1);
  assert.match(hits[0].statement, /Unknown query parameters/);
  const like = await queries.searchClaims(db, 'limit', 'mock-items');
  assert.ok(like.length >= 1);
  const tools = await queries.listTools(db);
  assert.equal(tools[0].name, 'mock-items');
  assert.equal(tools[0].versions, 2);
});

test('scenario: overlapping pages are reported as duplicates, reproduced by the Link walk', async () => {
  const quirky = await startMockApi('v1', { page_overlap: true });
  try {
    const { validateTarget } = await import('../../src/worker/target.js');
    const t2 = validateTarget({ name: 'mock-overlap', category: 'test', spec_url: quirky.specPath, baseline: { '/v1/items': { q: 'hello' } } });
    const s = await pipeline.runPipeline(db, t2, { ...fast, llm: null });
    const u = s.verified.find((c) => c.claimKey === 'scenario:pagination_unique:get_v1_items:-');
    assert.ok(u, 'uniqueness claim present: ' + JSON.stringify(s.verified.filter((c) => c.source === 'scenario').map((c) => c.statement)));
    assert.match(u!.statement, /repeats items across pages: 2 id\(s\) appear on more than one page \(e\.g\. 3 on pages 1 and 2\)/);
    assert.match(u!.statement, /in both a numbered walk and a Link-header walk/);
    // The sheet surfaces it in its own section, and the brief sheet carries it as a pagination watch-out.
    const { renderToolDocs } = await import('../../src/db/docs.js');
    const full = (await renderToolDocs(db, 'mock-overlap', null, { brief: false }))!;
    assert.match(full, /## How it behaves in use \(\d+\)/);
    assert.match(full, /repeats items across pages/);
    const brief = (await renderToolDocs(db, 'mock-overlap', null, { brief: true }))!;
    assert.match(brief, /repeats items across pages/);
  } finally {
    await quirky.close();
  }
});
