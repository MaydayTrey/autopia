/**
 * Stage 5.6 DIFF: when a prior version of the same tool has verified claims,
 * compare claim sets by claim_key.
 *
 *   added      key only in the new version
 *   removed    key only in the old version
 *   changed    same key, but verdict or expected statuses differ
 *   unchanged  same key, same verdict and statuses
 *
 * "changed" rows are the auto-generated changelog entries.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { Claim, ClaimDiff } from '../db/schema.js';
import type { Expectation } from './claims.js';
import { log } from './log.js';

export type ChangeType = 'unchanged' | 'changed' | 'added' | 'removed';

export interface DiffEntry {
  claimKey: string;
  changeType: ChangeType;
  from?: Claim;
  to?: Claim;
}

/** Pure comparison, testable without a DB. */
export function diffClaimSets(from: Claim[], to: Claim[]): DiffEntry[] {
  const a = new Map(from.map((c) => [c.claimKey, c]));
  const b = new Map(to.map((c) => [c.claimKey, c]));
  const out: DiffEntry[] = [];
  for (const [key, toClaim] of b) {
    const fromClaim = a.get(key);
    if (!fromClaim) out.push({ claimKey: key, changeType: 'added', to: toClaim });
    else out.push({ claimKey: key, changeType: sameBehavior(fromClaim, toClaim) ? 'unchanged' : 'changed', from: fromClaim, to: toClaim });
  }
  for (const [key, fromClaim] of a) if (!b.has(key)) out.push({ claimKey: key, changeType: 'removed', from: fromClaim });
  return out.sort((x, y) => x.claimKey.localeCompare(y.claimKey));
}

function sameBehavior(x: Claim, y: Claim): boolean {
  if (x.verdict !== y.verdict) return false;
  const sx = statusesOf(x);
  const sy = statusesOf(y);
  return sx === sy;
}

function statusesOf(c: Claim): string {
  // Expectations are keyed by trial id (differs per run); compare the multiset of statuses in claim order.
  return (c.expectations as unknown as Expectation[]).map((e) => e.status).join(',');
}

/** Latest finished run that stored claims for a version, or null. */
export async function latestClaimsForVersion(db: Db, toolVersionId: number): Promise<{ runId: number; claims: Claim[] } | null> {
  const runs = await db
    .select()
    .from(schema.testRuns)
    .where(and(eq(schema.testRuns.toolVersionId, toolVersionId), eq(schema.testRuns.status, 'finished')))
    .orderBy(desc(schema.testRuns.id));
  for (const r of runs) {
    const claims = await db.select().from(schema.claims).where(eq(schema.claims.testRunId, r.id));
    if (claims.length) return { runId: r.id, claims };
  }
  return null;
}

/** Find the newest OLDER version of this tool that has verified claims, diff, store rows. */
export async function computeAndStoreDiff(db: Db, toolId: number, toVersionId: number, toClaims: Claim[]): Promise<{ fromVersionId: number; entries: DiffEntry[]; rows: ClaimDiff[] } | null> {
  const older = await db
    .select()
    .from(schema.toolVersions)
    .where(and(eq(schema.toolVersions.toolId, toolId), lt(schema.toolVersions.id, toVersionId)))
    .orderBy(desc(schema.toolVersions.id));
  for (const v of older) {
    const prev = await latestClaimsForVersion(db, v.id);
    if (!prev) continue;
    const entries = diffClaimSets(prev.claims, toClaims);
    // replace any earlier diff for this pair
    await db.delete(schema.claimDiffs).where(and(eq(schema.claimDiffs.fromVersionId, v.id), eq(schema.claimDiffs.toVersionId, toVersionId)));
    const rows = entries.length
      ? await db
          .insert(schema.claimDiffs)
          .values(entries.map((e) => ({ toolId, fromVersionId: v.id, toVersionId, claimKey: e.claimKey, changeType: e.changeType, fromClaimId: e.from?.id ?? null, toClaimId: e.to?.id ?? null })))
          .returning()
      : [];
    const counts = countBy(entries);
    log.info('diff', `vs version #${v.id}: ${counts.added} added, ${counts.removed} removed, ${counts.changed} changed, ${counts.unchanged} unchanged`);
    return { fromVersionId: v.id, entries, rows };
  }
  log.info('diff', 'no prior version with claims; nothing to diff');
  return null;
}

export function countBy(entries: DiffEntry[]): Record<ChangeType, number> {
  const c: Record<ChangeType, number> = { unchanged: 0, changed: 0, added: 0, removed: 0 };
  for (const e of entries) c[e.changeType]++;
  return c;
}
