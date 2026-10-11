/**
 * CONTRIBUTOR TIER, server side. Import a bundle uploaded by a keyed user:
 *   - the bundle is checked structurally (no inputs/bodies) and every
 *     statement is scrubbed again; offending claims are dropped, not fixed
 *   - a tool already verified by THIS server (tier 'server') is never
 *     overwritten by a contribution
 *   - trials are stored as status + signature only; claims get
 *     verified_by = contributor:<key prefix> and verified_at = the
 *     contributor's run time, so the sheet can state the date honestly
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';
import { bundleProblem, scrubBundle, type ContributionBundle } from '../worker/contribute.js';

export interface ImportResult {
  toolId: number;
  toolVersionId: number;
  testRunId: number;
  isNewVersion: boolean;
  trials: number;
  claims: number;
  rejected: { claim_key: string; reason: string }[];
}

export async function importContribution(db: Db, contributor: { keyId: number | null; prefix: string }, raw: unknown): Promise<ImportResult> {
  const problem = bundleProblem(raw);
  if (problem) throw new Error(`bundle rejected: ${problem}`);
  const { clean: b, rejected } = scrubBundle(raw as ContributionBundle);
  if (b.claims.length === 0) throw new Error('bundle rejected: no claims survived the scrub');
  const verifiedBy = `contributor:${contributor.prefix}`;
  const verifiedAt = new Date(b.run.finished_at);
  if (Number.isNaN(verifiedAt.getTime())) throw new Error('bundle rejected: run.finished_at is not a date');

  let [tool] = await db.select().from(schema.tools).where(eq(schema.tools.name, b.tool.name));
  if (tool && tool.tier !== 'contributor') throw new Error(`"${b.tool.name}" is verified by this server; contributions cannot replace server-verified tools`);
  if (!tool) [tool] = await db.insert(schema.tools).values({ name: b.tool.name, kind: 'rest_api', category: b.tool.category, tier: 'contributor' }).returning();

  let [version] = await db.select().from(schema.toolVersions).where(and(eq(schema.toolVersions.toolId, tool.id), eq(schema.toolVersions.specHash, b.tool.spec_hash)));
  let isNewVersion = false;
  if (!version) {
    [version] = await db.insert(schema.toolVersions).values({ toolId: tool.id, versionLabel: b.tool.version_label, specUrl: b.tool.spec_url, specBlob: (b.tool.spec_blob ?? {}) as object, specHash: b.tool.spec_hash }).returning();
    isNewVersion = true;
  }

  const [run] = await db
    .insert(schema.testRuns)
    .values({
      toolVersionId: version.id,
      batteryHash: b.run.battery_hash,
      status: 'finished',
      startedAt: new Date(b.run.started_at),
      finishedAt: verifiedAt,
      llmModel: b.run.llm_model,
      llmInputTokens: b.run.llm_input_tokens,
      llmOutputTokens: b.run.llm_output_tokens,
      stats: { contributed: true, contributor: verifiedBy, contributor_key_id: contributor.keyId, trials: b.run.trials, claims: b.claims.length, scrub_rejected: rejected.length },
    })
    .returning();

  // trials: status + shape only. The stored input says so explicitly.
  const refToId = new Map<number, number>();
  for (let i = 0; i < b.trials.length; i += 200) {
    const slice = b.trials.slice(i, i + 200);
    const rows = await db
      .insert(schema.trials)
      .values(
        slice.map((t) => ({
          testRunId: run.id,
          endpoint: t.endpoint,
          mutationType: t.mutation_type,
          mutationId: t.mutation_id,
          paramName: t.param,
          input: { contributed: true, note: 'inputs are not uploaded in the contributor tier' } as object,
          inputHash: t.input_hash,
          response: { status: t.status, headers: {}, body: null, bodyKind: t.signature.bodyKind, contributed: true } as object,
          signature: t.signature as unknown as object,
          statusCode: t.status,
          errorText: null,
          latencyMs: 0,
        })),
      )
      .returning({ id: schema.trials.id });
    slice.forEach((t, j) => refToId.set(t.ref, rows[j].id));
  }

  const claimRows = b.claims.map((c) => ({
    toolVersionId: version.id,
    testRunId: run.id,
    claimKey: c.claim_key,
    statement: c.statement,
    endpoint: c.endpoint,
    kind: c.kind,
    paramName: c.param,
    verdict: c.verdict,
    source: c.source,
    confidence: c.confidence,
    divergenceType: c.divergence_type,
    specSays: c.spec_says,
    verified: true,
    verifiedBy,
    verifiedAt,
    evidenceTrialIds: c.evidence.map((r) => refToId.get(r)!),
    expectations: c.expectations.map((e) => ({ trial_id: refToId.get(e.trial_id)!, status: e.status })) as unknown as object,
  }));
  for (let i = 0; i < claimRows.length; i += 200) await db.insert(schema.claims).values(claimRows.slice(i, i + 200)).onConflictDoNothing();

  return { toolId: tool.id, toolVersionId: version.id, testRunId: run.id, isNewVersion, trials: b.trials.length, claims: claimRows.length, rejected };
}

/** Latest contribution run for a tool, if any (for status endpoints). */
export async function latestContribution(db: Db, toolName: string) {
  const [tool] = await db.select().from(schema.tools).where(eq(schema.tools.name, toolName));
  if (!tool || tool.tier !== 'contributor') return null;
  const [run] = await db
    .select()
    .from(schema.testRuns)
    .innerJoin(schema.toolVersions, eq(schema.testRuns.toolVersionId, schema.toolVersions.id))
    .where(eq(schema.toolVersions.toolId, tool.id))
    .orderBy(desc(schema.testRuns.id))
    .limit(1);
  return run ? { tool, run: run.test_runs, version: run.tool_versions } : null;
}
