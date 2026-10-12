/**
 * RETENTION: keep the database small without losing anything an agent can
 * query or a diff can cite.
 *
 * Kept, always:
 *   - the latest FINISHED run of every tool version (its claims are the
 *     "current" claims; its trials are their evidence)
 *   - any run whose claims are referenced by a claim_diff row
 *   - any run younger than `keepDays`
 * Deleted: every other run, with its claims and trials. Older history of the
 * same version adds nothing: determinism checks compare the last two runs,
 * and diffs are between versions, not runs.
 */
import { and, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';

export interface PruneOptions {
  keepDays: number;
  now?: Date;
  dryRun?: boolean;
}

export interface PruneResult {
  runsDeleted: number;
  claimsDeleted: number;
  trialsDeleted: number;
  runIds: number[];
}

/** How long per-call usage records (tool, target, key id or hashed address) are kept. Stated in plugin/PRIVACY.md; change both together. */
export const CALL_LOG_DAYS = 30;

/** Delete api_calls older than keepDays. Usage summaries look back at most this far; nothing else reads the table. */
export async function pruneCalls(db: Db, keepDays = CALL_LOG_DAYS, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const rows = await db.delete(schema.apiCalls).where(lt(schema.apiCalls.createdAt, cutoff)).returning({ id: schema.apiCalls.id });
  return rows.length;
}

export async function pruneRuns(db: Db, opts: PruneOptions): Promise<PruneResult> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - opts.keepDays * 86_400_000);

  // latest finished run per version
  const finished = await db.select({ id: schema.testRuns.id, v: schema.testRuns.toolVersionId }).from(schema.testRuns).where(eq(schema.testRuns.status, 'finished')).orderBy(desc(schema.testRuns.id));
  const latestPerVersion = new Set<number>();
  const seenVersion = new Set<number>();
  for (const r of finished) {
    if (!seenVersion.has(r.v)) {
      seenVersion.add(r.v);
      latestPerVersion.add(r.id);
    }
  }
  // runs referenced by diffs (through their claims)
  const diffClaimIds = (await db.select({ a: schema.claimDiffs.fromClaimId, b: schema.claimDiffs.toClaimId }).from(schema.claimDiffs)).flatMap((d) => [d.a, d.b]).filter((x): x is number => x !== null);
  const diffRuns = diffClaimIds.length ? new Set((await db.select({ r: schema.claims.testRunId }).from(schema.claims).where(inArray(schema.claims.id, diffClaimIds))).map((x) => x.r)) : new Set<number>();

  const protectedRuns = [...new Set([...latestPerVersion, ...diffRuns])];
  const candidates = await db
    .select({ id: schema.testRuns.id })
    .from(schema.testRuns)
    .where(and(lt(schema.testRuns.startedAt, cutoff), protectedRuns.length ? notInArray(schema.testRuns.id, protectedRuns) : sql`true`));
  const runIds = candidates.map((c) => c.id);
  if (runIds.length === 0) return { runsDeleted: 0, claimsDeleted: 0, trialsDeleted: 0, runIds };

  const [{ n: claimsN }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.claims).where(inArray(schema.claims.testRunId, runIds));
  const [{ n: trialsN }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.trials).where(inArray(schema.trials.testRunId, runIds));
  if (opts.dryRun) return { runsDeleted: runIds.length, claimsDeleted: Number(claimsN), trialsDeleted: Number(trialsN), runIds };

  await db.delete(schema.claims).where(inArray(schema.claims.testRunId, runIds));
  await db.delete(schema.trials).where(inArray(schema.trials.testRunId, runIds));
  await db.delete(schema.testRuns).where(inArray(schema.testRuns.id, runIds));
  return { runsDeleted: runIds.length, claimsDeleted: Number(claimsN), trialsDeleted: Number(trialsN), runIds };
}
