/**
 * SCENARIO BATTERY, scenarios 3 and 6 in one request sequence: CONDITIONAL REQUESTS and
 * RATE-LIMIT ACCOUNTING.
 *
 * A program polling an endpoint wants to know three things the docs rarely state:
 *   C1  does the API honor If-None-Match (an ETag round trip yields 304 with no body)?
 *   C2  does that 304 cost a request against the rate limit, or is polling free?
 *   C3  does If-Modified-Since work when only Last-Modified is sent?
 *   R1  does each counted request decrement the remaining counter by exactly one, with the
 *       reset unchanged (a fixed window), and what format is the reset value in?
 *
 * Sequence per endpoint (at most four requests, spaced like the battery):
 *   1 fresh GET of the baseline                       -> ETag, Last-Modified, remaining/reset
 *   2 GET with If-None-Match: <that ETag>             -> 304 or 200; remaining
 *   3 GET with If-None-Match: a stale tag             -> must be 200 (proves 2 was conditional); remaining
 *   4 GET with If-Modified-Since: <Last-Modified>     -> 304 or 200 (only when Last-Modified was sent)
 *
 * Statements name no volatile numbers (remaining counts change every run) so claim text is
 * stable across nightly runs; the evidence trials carry the numbers.
 */
import type { Db } from '../../db/client.js';
import type { Trial } from '../../db/schema.js';
import { buildBaseline } from '../battery/index.js';
import { scenarioClaimKey, type CandidateClaim } from '../claims.js';
import type { ExerciseOptions } from '../exercise.js';
import type { TrialInput } from '../http.js';
import { log } from '../log.js';
import { endpointLabel, type EndpointSpec } from '../spec.js';
import type { TargetConfig } from '../target.js';
import { makeRequester } from './runner.js';

export const STALE_TAG = '"autopia-stale-tag"';

export interface CondObs {
  trialId: number;
  step: 'fresh' | 'if_none_match' | 'stale_tag' | 'if_modified_since' | 'repeat';
  status: number | null;
  bodyKind: string;
  headers: Record<string, string>;
}

/** The rate-limit header family a response uses, normalised to remaining/reset/limit numbers. */
export function rateHeaders(h: Record<string, string>): { family: string; remaining: number | null; reset: number | null; limit: number | null } | null {
  const fams = [
    ['x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-limit'],
    ['ratelimit-remaining', 'ratelimit-reset', 'ratelimit-limit'],
    ['x-rate-limit-remaining', 'x-rate-limit-reset', 'x-rate-limit-limit'],
  ];
  for (const [rem, reset, limit] of fams) {
    if (h[rem] === undefined) continue;
    const n = (v: string | undefined) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    return { family: rem.replace(/-remaining$/, ''), remaining: n(h[rem]), reset: n(h[reset]), limit: n(h[limit]) };
  }
  return null;
}

/** How a reset value reads: epoch seconds, epoch milliseconds, or seconds until reset. */
export function resetFormat(reset: number | null): string | null {
  if (reset === null) return null;
  if (reset > 1e12) return 'epoch milliseconds';
  if (reset > 1e9) return 'epoch seconds';
  if (reset >= 0) return 'seconds until reset';
  return null;
}

export function conditionalClaims(endpoint: string, obs: CondObs[], trials: Map<number, { statusCode: number | null }>): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  const by = Object.fromEntries(obs.map((o) => [o.step, o])) as Partial<Record<CondObs['step'], CondObs>>;
  const fresh = by.fresh;
  if (!fresh || fresh.status === null || fresh.status >= 300) return out;
  const claim = (check: string, statement: string, evidence: CondObs[], confidence = 0.9): CandidateClaim => {
    const ids = [...new Set(evidence.map((o) => o.trialId))].sort((a, b) => a - b);
    return {
      claim_key: scenarioClaimKey(check, endpoint),
      statement,
      endpoint,
      kind: 'undocumented',
      param: null,
      verdict: 'observes',
      source: 'scenario',
      confidence,
      evidence_trial_ids: ids,
      expectations: ids.map((id) => ({ trial_id: id, status: trials.get(id)?.statusCode ?? null })),
      diverges_from_spec: false,
      spec_says: null,
    };
  };
  const etag = fresh.headers['etag'];
  const lastMod = fresh.headers['last-modified'];
  const inm = by.if_none_match;
  const stale = by.stale_tag;
  const ims = by.if_modified_since;

  // C1 ETag round trip.
  if (etag && inm && stale && inm.status !== null && stale.status !== null) {
    if (inm.status === 304 && stale.status === 200) out.push(claim('conditional_etag', `Responses carry an ETag and honor If-None-Match: re-requesting with the current tag returns HTTP 304 with an empty body, while a stale tag returns HTTP 200 with the full body. Poll with If-None-Match instead of re-fetching.`, [fresh, inm, stale]));
    else if (inm.status === 200 && stale.status === 200) out.push(claim('conditional_etag', `Responses carry an ETag but If-None-Match is ignored: re-requesting with the current tag still returns HTTP 200 with the full body. Conditional polling saves nothing here.`, [fresh, inm, stale]));
    else if (inm.status === 304 && stale.status === 304) out.push(claim('conditional_etag', `If-None-Match returns HTTP 304 for ANY tag, including a stale one: the 304 is not conditional on the ETag, so a cached copy may be silently kept past a change.`, [fresh, inm, stale], 0.8));
    else out.push(claim('conditional_etag', `If-None-Match behaves inconsistently: the current tag returned HTTP ${inm.status} and a stale tag HTTP ${stale.status}.`, [fresh, inm, stale], 0.6));
  } else if (!etag && !lastMod) {
    out.push(claim('conditional_none', `Responses carry neither ETag nor Last-Modified (HTTP ${fresh.status}): conditional requests are not possible, so every poll is a full request against the rate limit.`, [fresh]));
  }

  // C3 Last-Modified round trip.
  if (lastMod && ims) {
    if (ims.status === 304) out.push(claim('conditional_last_modified', `Responses carry Last-Modified and honor If-Modified-Since: re-requesting with that value returns HTTP 304 with an empty body.`, [fresh, ims]));
    else if (ims.status === 200) out.push(claim('conditional_last_modified', `Responses carry Last-Modified but If-Modified-Since is ignored: re-requesting with that value still returns HTTP 200 with the full body.`, [fresh, ims]));
  }

  // C2 does a 304 cost a request? Needs the counter on all three and a fixed window across them.
  const rFresh = rateHeaders(fresh.headers);
  const rInm = inm ? rateHeaders(inm.headers) : null;
  const rStale = stale ? rateHeaders(stale.headers) : null;
  const sameWindow = (a: ReturnType<typeof rateHeaders>, b: ReturnType<typeof rateHeaders>) => !!a && !!b && a.remaining !== null && b.remaining !== null && (a.reset === null || b.reset === null || a.reset === b.reset || resetFormat(a.reset) === 'seconds until reset');
  if (inm?.status === 304 && stale?.status === 200 && rFresh && rInm && rStale && sameWindow(rFresh, rInm) && sameWindow(rInm, rStale)) {
    const costOf304 = rFresh.remaining! - rInm.remaining!;
    const costOf200 = rInm.remaining! - rStale.remaining!;
    const fam = rFresh.family;
    if (costOf304 === 0 && costOf200 === 1) out.push(claim('conditional_cost', `A 304 Not Modified does not count against the rate limit: ${fam}-remaining was unchanged by the conditional request and dropped by 1 for the full request that followed. Polling with If-None-Match is free until the resource changes.`, [fresh, inm, stale]));
    else if (costOf304 === 1 && costOf200 === 1) out.push(claim('conditional_cost', `A 304 Not Modified still counts against the rate limit: ${fam}-remaining dropped by 1 for the conditional request, the same as for a full request. If-None-Match saves bandwidth, not quota.`, [fresh, inm, stale]));
    else if (costOf304 >= 0 && costOf200 >= 0) out.push(claim('conditional_cost', `Rate-limit accounting for conditional requests: ${fam}-remaining dropped by ${costOf304} for the 304 and by ${costOf200} for the following full request.`, [fresh, inm, stale], 0.7));
  }

  // R1 per-request decrement and reset format, from consecutive FULL requests. The last full
  // request is the stale-tag one (ETag path) or the plain repeat (no ETag). When the conditional
  // request in between was a 304 its cost is excluded; when it was a full 200 it counts as one.
  const last = stale ?? by.repeat;
  const rLast = last ? rateHeaders(last.headers) : null;
  // A 304 without rate headers leaves its cost unknown, so the accounting over it is not claimed.
  if (last?.status === 200 && rFresh && rLast && rFresh.remaining !== null && rLast.remaining !== null && !(inm?.status === 304 && !rInm)) {
    const fam = rFresh.family;
    const fmt = resetFormat(rFresh.reset);
    const fmtText = fmt ? ` ${fam}-reset is ${fmt}.` : '';
    const fixedWindow = rFresh.reset !== null && rLast.reset !== null && rFresh.reset === rLast.reset && fmt !== 'seconds until reset';
    let start: CondObs = fresh;
    let startRem = rFresh.remaining;
    let fulls = 1; // full requests between start and last
    if (inm && stale) {
      if (inm.status === 304 && rInm?.remaining !== null && rInm) {
        start = inm; // measure the single full request after the 304
        startRem = rInm.remaining;
      } else fulls = 2; // fresh -> inm (200) -> stale (200)
    }
    const total = startRem - rLast.remaining;
    if (total < 0) log.debug('scenario', `${endpoint}: rate-limit window rolled over mid-scenario; accounting not claimed`);
    const limitText = rFresh.limit !== null ? ` The limit is ${rFresh.limit}${rLast.limit !== null && rLast.limit !== rFresh.limit ? ` (it changed to ${rLast.limit} on the next response)` : ''}.` : '';
    if (total === fulls) out.push(claim('rate_limit_accounting', `Each full request decrements ${fam}-remaining by exactly 1${fixedWindow ? ` with ${fam}-reset unchanged (a fixed window, not a sliding one)` : ''}.${fmtText}${limitText}`, [start, last]));
    else if (total === 0) out.push(claim('rate_limit_accounting', `${fam}-remaining did not change across ${fulls + 1} consecutive full requests: calls to this endpoint are not counted against the limit (or the counter is shared or coarse-grained).${fmtText}${limitText}`, [start, last], 0.7));
    else if (total % fulls === 0) out.push(claim('rate_limit_accounting', `Each full request decrements ${fam}-remaining by ${total / fulls}, not 1: requests are weighted.${fmtText}`, [start, last], 0.8));
  }
  return out;
}

export async function runConditionalScenario(db: Db, testRunId: number, ep: EndpointSpec, target: TargetConfig, opts: ExerciseOptions): Promise<{ trials: Trial[]; claims: CandidateClaim[]; requests: number }> {
  const label = endpointLabel(ep);
  const base = buildBaseline(ep, target);
  const req = makeRequester(db, testRunId, label, target, opts);
  const obs: CondObs[] = [];
  const record = (trial: Trial, step: CondObs['step'], status: number | null, bodyKind: string, headers: Record<string, string>) => obs.push({ trialId: trial.id, step, status, bodyKind, headers });
  const withHeaders = (h: Record<string, string>): TrialInput => ({ ...base.input, headers: { ...base.input.headers, ...h }, query: [...base.input.query] });

  const fresh = await req.send(withHeaders({}), 'scenario:conditional:fresh');
  record(fresh.trial, 'fresh', fresh.out.status, fresh.out.bodyKind, fresh.out.headers);
  if (fresh.out.status === null || fresh.out.status >= 300) return { trials: req.trials, claims: [], requests: req.count };
  const etag = fresh.out.headers['etag'];
  const lastMod = fresh.out.headers['last-modified'];
  if (etag) {
    const inm = await req.send(withHeaders({ 'if-none-match': etag }), 'scenario:conditional:if-none-match');
    record(inm.trial, 'if_none_match', inm.out.status, inm.out.bodyKind, inm.out.headers);
    const stale = await req.send(withHeaders({ 'if-none-match': STALE_TAG }), 'scenario:conditional:stale-tag');
    record(stale.trial, 'stale_tag', stale.out.status, stale.out.bodyKind, stale.out.headers);
  } else {
    // No ETag: a plain second request still measures the per-request rate-limit decrement.
    const rep = await req.send(withHeaders({}), 'scenario:conditional:repeat');
    record(rep.trial, 'repeat', rep.out.status, rep.out.bodyKind, rep.out.headers);
  }
  if (lastMod) {
    const ims = await req.send(withHeaders({ 'if-modified-since': lastMod }), 'scenario:conditional:if-modified-since');
    record(ims.trial, 'if_modified_since', ims.out.status, ims.out.bodyKind, ims.out.headers);
  }
  const byId = new Map(req.trials.map((t) => [t.id, t]));
  const claims = conditionalClaims(label, obs, byId);
  log.info('scenario', `${label}: conditional scenario made ${req.count} request(s), ${claims.length} claim(s)`);
  return { trials: req.trials, claims, requests: req.count };
}
