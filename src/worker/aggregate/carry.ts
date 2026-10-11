/**
 * CARRY-FORWARD of LLM claims (cost control).
 *
 * The LLM pass is the only per-run cost that scales with targets, so the
 * nightly refresh runs rules-only and the model runs weekly. Without this
 * step, a rules-only run would become the "current" run and the model's
 * claims would disappear six nights out of seven.
 *
 * Instead, every run re-admits the previous run's LLM claims as candidates:
 * each cited trial is remapped to tonight's trial with the same endpoint and
 * probe (mutation id), the expected status is kept, and the claim then goes
 * through the same evidence check, cross-ref and reproduction as everything
 * else. No model call. A carried claim whose probe now behaves differently
 * fails the evidence check and is dropped, which is exactly right.
 */
import type { Claim, Trial } from '../../db/schema.js';
import type { CandidateClaim, Expectation } from '../claims.js';
import { log } from '../log.js';

export interface CarryResult {
  claims: CandidateClaim[];
  dropped: { claim_key: string; reason: string }[];
}

/**
 * @param prev       claims of the previous run (any source; only 'llm' are carried)
 * @param prevTrials the previous run's trials the claims cite (id -> trial), for endpoint + mutation id
 * @param trials     this run's trials
 */
export function carryForwardLlmClaims(prev: Claim[], prevTrials: Map<number, Trial>, trials: Trial[]): CarryResult {
  const byProbe = new Map<string, Trial>();
  for (const t of trials) byProbe.set(`${t.endpoint}|${t.mutationId}`, t);
  const out: CarryResult = { claims: [], dropped: [] };

  for (const c of prev) {
    if (c.source !== 'llm') continue;
    const expectations: Expectation[] = [];
    let reason: string | null = null;
    for (const e of c.expectations as unknown as Expectation[]) {
      const old = prevTrials.get(e.trial_id);
      if (!old) {
        reason = `previous trial ${e.trial_id} no longer exists`;
        break;
      }
      const now = byProbe.get(`${old.endpoint}|${old.mutationId}`);
      if (!now) {
        reason = `probe ${old.mutationId} not in this run`;
        break;
      }
      expectations.push({ trial_id: now.id, status: e.status });
    }
    if (reason) {
      out.dropped.push({ claim_key: c.claimKey, reason });
      continue;
    }
    out.claims.push({
      claim_key: c.claimKey,
      statement: c.statement,
      endpoint: c.endpoint,
      kind: c.kind as CandidateClaim['kind'],
      param: c.paramName,
      verdict: c.verdict as CandidateClaim['verdict'],
      source: 'llm',
      confidence: c.confidence,
      evidence_trial_ids: expectations.map((e) => e.trial_id),
      expectations,
      diverges_from_spec: c.divergenceType === 'spec',
      spec_says: c.specSays,
    });
  }
  if (out.claims.length || out.dropped.length) log.info('aggregate', `carried forward ${out.claims.length} LLM claim(s) from the previous run, ${out.dropped.length} could not be remapped`);
  return out;
}
