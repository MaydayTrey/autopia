/**
 * Stage 5.5 VERIFY (NO LLM). The trust guarantee.
 *
 *   b. EVIDENCE CHECK (free): every cited trial id exists in this run and its
 *      logged status equals what the claim says it showed. Mismatch -> discard.
 *   c. REPRODUCTION (cheap): re-execute the exact pinned input of every cited
 *      trial and compare the fresh response SIGNATURE with the stored one.
 *      Non-reproducing -> discard the claim (it was noise or a model artifact).
 *
 * Each distinct trial is re-run once per verify pass and cached, so claims
 * that share evidence (most cite the baseline) do not multiply traffic.
 */
import type { Trial } from '../db/schema.js';
import type { CandidateClaim } from './claims.js';
import { runOne, type ExerciseOptions } from './exercise.js';
import type { TrialInput } from './http.js';
import { log } from './log.js';
import { restoreInput } from './redact.js';
import { describeSignature, signaturesEqual, type ResponseSignature } from './signature.js';

export interface VerifyOptions extends ExerciseOptions {
  reproduce?: boolean; // default true; false = evidence check only (debugging)
  minIntervalMs?: number;
  /** Credentials to put back into redacted stored inputs before re-executing (from the target). */
  secrets?: Record<string, string>;
  /** Per-endpoint minimum spacing (from the target's rate_overrides); the larger of this and minIntervalMs is used. */
  intervalFor?: (endpoint: string) => number;
}

export interface VerifyResult {
  verified: CandidateClaim[];
  rejected: { claim: CandidateClaim; reason: string }[];
  reproductions: { trialId: number; ok: boolean; stored: ResponseSignature; fresh: ResponseSignature | null }[];
}

export function evidenceCheck(c: CandidateClaim, trialsById: Map<number, Trial>): string | null {
  if (c.evidence_trial_ids.length === 0) return 'no evidence cited';
  const expected = new Map(c.expectations.map((e) => [e.trial_id, e.status]));
  for (const id of c.evidence_trial_ids) {
    const t = trialsById.get(id);
    if (!t) return `cited trial ${id} does not exist in this run`;
    if (!expected.has(id)) return `cited trial ${id} has no stated expectation`;
    if (t.statusCode !== expected.get(id)) return `trial ${id} showed status ${t.statusCode}, claim says ${expected.get(id)}`;
  }
  return null;
}

export async function verify(claims: CandidateClaim[], trialsById: Map<number, Trial>, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const rejected: VerifyResult['rejected'] = [];
  const passEvidence: CandidateClaim[] = [];
  for (const c of claims) {
    const err = evidenceCheck(c, trialsById);
    if (err) rejected.push({ claim: c, reason: `evidence: ${err}` });
    else passEvidence.push(c);
  }
  log.info('verify', `evidence check: ${passEvidence.length} pass, ${rejected.length} fail`);

  const reproductions: VerifyResult['reproductions'] = [];
  if (opts.reproduce === false) {
    log.warn('verify', 'reproduction SKIPPED (reproduce=false); claims are NOT verified');
    return { verified: [], rejected: [...rejected, ...passEvidence.map((claim) => ({ claim, reason: 'reproduction skipped' }))], reproductions };
  }

  const ids = [...new Set(passEvidence.flatMap((c) => c.evidence_trial_ids))].sort((a, b) => a - b);
  log.info('verify', `reproducing ${ids.length} distinct trials`);
  const cache = new Map<number, boolean>();
  const interval = opts.minIntervalMs ?? 150;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const id of ids) {
    const t = trialsById.get(id)!;
    const stored = t.signature as unknown as ResponseSignature;
    const gap = Math.max(interval, opts.intervalFor?.(t.endpoint) ?? 0);
    const input = restoreInput(t.input as unknown as TrialInput, opts.secrets ?? {});
    let { out } = await runOne(input, opts);
    let same = signaturesEqual(stored, out.signature);
    if (!same) {
      // One retry: a transient upstream hiccup must not discard a true claim.
      // The retry must match the STORED signature exactly as before; no loosening.
      log.debug('verify', `trial ${id} (${t.mutationId}) mismatched once (${describeSignature(out.signature)}); retrying`);
      if (gap > 0) await sleep(gap);
      out = (await runOne(input, opts)).out;
      same = signaturesEqual(stored, out.signature);
    }
    cache.set(id, same);
    reproductions.push({ trialId: id, ok: same, stored, fresh: out.signature });
    if (!same) log.warn('verify', `trial ${id} (${t.mutationId}) did NOT reproduce (2 attempts): stored ${describeSignature(stored)}, fresh ${describeSignature(out.signature)}`);
    else log.debug('verify', `trial ${id} (${t.mutationId}) reproduced: ${describeSignature(stored)}`);
    if (interval > 0) await sleep(interval);
  }

  const verified: CandidateClaim[] = [];
  for (const c of passEvidence) {
    const failing = c.evidence_trial_ids.filter((id) => cache.get(id) === false);
    if (failing.length) rejected.push({ claim: c, reason: `reproduction: trial(s) ${failing.join(',')} did not reproduce` });
    else verified.push(c);
  }
  log.info('verify', `${verified.length} claims verified, ${rejected.length} rejected`);
  return { verified, rejected, reproductions };
}
