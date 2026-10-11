/**
 * Stage 5.6 WRITE: store verified claims for this test_run.
 * Embeddings are left NULL in v1 (search uses Postgres text search).
 */
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { Claim, NewClaim } from '../db/schema.js';
import type { CandidateClaim } from './claims.js';
import { log } from './log.js';

export async function writeClaims(db: Db, toolVersionId: number, testRunId: number, verified: CandidateClaim[]): Promise<Claim[]> {
  if (verified.length === 0) {
    log.warn('write', 'no verified claims to store');
    return [];
  }
  const rows: NewClaim[] = verified.map((c) => ({
    toolVersionId,
    testRunId,
    claimKey: c.claim_key,
    statement: c.statement,
    endpoint: c.endpoint,
    kind: c.kind,
    paramName: c.param,
    verdict: c.verdict,
    source: c.source,
    confidence: c.confidence,
    divergenceType: c.diverges_from_spec ? 'spec' : null,
    specSays: c.spec_says,
    verified: true,
    evidenceTrialIds: c.evidence_trial_ids,
    expectations: c.expectations as unknown as object,
  }));
  const inserted = await db.insert(schema.claims).values(rows).returning();
  log.info('write', `stored ${inserted.length} verified claims (${inserted.filter((c) => c.divergenceType).length} divergences)`);
  return inserted;
}
