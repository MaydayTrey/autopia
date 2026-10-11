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

/**
 * A fresh LLM pass does not know what was carried, so it restates findings in
 * new words, with the kind, param or verdict slot filled differently; both
 * then survive the exact-key dedupe and the sheet says the same thing twice
 * (anthropic-api run #44: before_id/after_id cursor rule, unknown model id;
 * pypi run #46: empty project segment, filed once as error_behavior and once
 * as undocumented). Two LLM claims on the same endpoint citing the same
 * probes (baseline ignored) describe the same observation. So:
 *   - a carried claim is SUPERSEDED by a fresh claim with the same
 *     endpoint + probe set; the fresh wording wins and still goes through
 *     evidence check and reproduction like everything else;
 *   - two CARRIED claims with the same endpoint + probe set keep only the
 *     more confident one (first on a tie), or else carried duplicates from
 *     an earlier run would survive forever.
 * Claims that cite only the baseline keep their kind in the key: one
 * endpoint legitimately has several baseline-only observations.
 */
export function dropSupersededCarried(carried: CarryResult, fresh: CandidateClaim[], trialsById: Map<number, Trial>): CarryResult {
  const dedupeKey = (c: CandidateClaim) => {
    const probes = [...new Set(c.evidence_trial_ids.map((id) => trialsById.get(id)?.mutationId ?? `#${id}`).filter((m) => m !== 'baseline'))].sort().join('+');
    return probes ? `${c.endpoint}|${probes}` : `${c.endpoint}|baseline|${c.kind}`;
  };
  const freshKeys = new Map<string, string>();
  for (const f of fresh) freshKeys.set(dedupeKey(f), f.claim_key);
  const out: CarryResult = { claims: [], dropped: [...carried.dropped] };
  const keptByKey = new Map<string, CandidateClaim>();
  const sorted = [...carried.claims].sort((a, b) => b.confidence - a.confidence); // stable: ties keep input order
  for (const c of sorted) {
    const k = dedupeKey(c);
    const by = freshKeys.get(k);
    if (by && by !== c.claim_key) {
      out.dropped.push({ claim_key: c.claim_key, reason: `superseded by fresh LLM claim ${by}` });
      continue;
    }
    const prior = keptByKey.get(k);
    if (prior && prior.claim_key !== c.claim_key) {
      out.dropped.push({ claim_key: c.claim_key, reason: `duplicate of carried claim ${prior.claim_key} (same endpoint and probes)` });
      continue;
    }
    keptByKey.set(k, c);
  }
  // Preserve the original carried order for everything kept.
  out.claims = carried.claims.filter((c) => keptByKey.get(dedupeKey(c)) === c);
  const n = out.dropped.length - carried.dropped.length;
  if (n) log.info('aggregate', `${n} carried LLM claim(s) dropped as restated by a fresh claim or by another carried claim citing the same probes`);
  return out;
}
