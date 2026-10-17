/**
 * Stage 5.2 EXERCISE (cheap loop, NO LLM)
 *   In:  parsed endpoints + the battery + the target's polite-rate settings
 *   Do:  plan trials deterministically, execute them with a concurrency cap
 *        and a minimum spacing between request starts, log every one as a
 *        TRIAL row (input, response, signature, status, latency, input_hash).
 *   Out: TRIAL rows for this test_run.
 */
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { NewTrial, Trial } from '../db/schema.js';
import { planTrials, type Mutation } from './battery/index.js';
import { execute, hashInput, truncateBody, type FetchLike, type TrialInput } from './http.js';
import { log } from './log.js';
import { redactInput, redactResponseHeaders } from './redact.js';
import { endpointLabel, type EndpointSpec } from './spec.js';
import { intervalFor, type TargetConfig } from './target.js';

export interface ExerciseOptions {
  maxTrials?: number;
  concurrency?: number;
  minIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  /** Abort the run if this many of the first trials all fail at the transport level (default 5). */
  unreachableAfter?: number;
}

export interface PlannedTrial extends Mutation {
  endpoint: string;
}

/** Plan across all endpoints, capped deterministically (plan order is stable). */
export function planAll(endpoints: EndpointSpec[], target: TargetConfig, maxTrials: number): PlannedTrial[] {
  const all: PlannedTrial[] = [];
  for (const ep of endpoints) {
    const label = endpointLabel(ep);
    for (const m of planTrials(ep, target)) all.push({ ...m, endpoint: label });
  }
  if (all.length > maxTrials) {
    log.warn('exercise', `plan has ${all.length} trials; capping at ${maxTrials} (raise max_trials in the target to run all)`);
    return all.slice(0, maxTrials);
  }
  return all;
}

/**
 * Lengths of the top-level array ("" key) and of first-level array fields, recorded
 * BEFORE truncation so list semantics (clamped per_page, empty last page) stay
 * checkable even though stored bodies keep only a few elements.
 */
export function arrayLengths(body: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (Array.isArray(body)) out[''] = body.length;
  else if (body && typeof body === 'object') for (const [k, v] of Object.entries(body as object)) if (Array.isArray(v)) out[k] = v.length;
  return out;
}

/** Execute one trial input and shape it as a DB row (no insert). Reused by VERIFY. */
export async function runOne(input: TrialInput, opts: ExerciseOptions) {
  const out = await execute(input, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
  // Credentials never reach the database: the stored input (and its hash) are the redacted form.
  const stored = redactInput(input);
  return {
    out,
    row: {
      input: stored as unknown as object,
      inputHash: hashInput(stored),
      response: { status: out.status, headers: redactResponseHeaders(out.headers), body: truncateBody(out.body), bodyKind: out.bodyKind, arrayLengths: arrayLengths(out.body) } as object,
      signature: out.signature as unknown as object,
      statusCode: out.status,
      errorText: out.transportError ?? (out.rateLimited ? 'rate_limited' : out.signature.errorMessage),
      latencyMs: out.latencyMs,
    },
  };
}

/**
 * The reason to fail the run when the API could not be reached, else null. A run whose every
 * baseline request died at the transport level (DNS, TLS, timeout) has observed nothing; letting it
 * finish would replace a night's verified claims with an empty set (open-meteo-forecast, 2026-10-17:
 * 108 claims -> 5) or burn an LLM pass on silence (jikan). A failed run keeps the previous
 * finished run's claims current.
 */
export function unreachable(trials: Pick<Trial, 'mutationId' | 'statusCode' | 'errorText'>[]): string | null {
  const baselines = trials.filter((t) => t.mutationId === 'baseline');
  const deadBaselines = baselines.filter((t) => t.statusCode === null);
  if (baselines.length && deadBaselines.length === baselines.length) return `API unreachable: all ${baselines.length} baseline request(s) failed at the transport level (${deadBaselines[0].errorText ?? 'no response'}); run failed so the previous claims stand`;
  const dead = trials.filter((t) => t.statusCode === null).length;
  if (trials.length >= 10 && dead / trials.length > 0.5) return `API unreachable: ${dead} of ${trials.length} requests failed at the transport level; run failed so the previous claims stand`;
  return null;
}

export async function exercise(db: Db, testRunId: number, endpoints: EndpointSpec[], target: TargetConfig, opts: ExerciseOptions = {}): Promise<Trial[]> {
  const plan = planAll(endpoints, target, opts.maxTrials ?? target.max_trials ?? 500);
  const concurrency = opts.concurrency ?? target.rate?.concurrency ?? 2;
  const minInterval = opts.minIntervalMs ?? target.rate?.min_interval_ms ?? 150;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  log.info('exercise', `${plan.length} trials planned, concurrency ${concurrency}, spacing ${minInterval}ms`);

  const results: (Trial | undefined)[] = new Array(plan.length);
  let next = 0;
  let done = 0;
  let nextSlot = 0;
  const nextSlotByEndpoint = new Map<string, number>(); // per-path overrides (e.g. a search quota)
  let transportErrors = 0;
  let aborted: Error | null = null;
  const UNREACHABLE_AFTER = opts.unreachableAfter ?? 5;

  async function worker() {
    while (true) {
      if (aborted) return;
      const i = next++;
      if (i >= plan.length) return;
      const t = plan[i];
      const now = Date.now();
      // global spacing, plus a per-endpoint spacing when the target overrides it for that path
      const epInterval = intervalFor(target, t.endpoint);
      const epSlot = epInterval > minInterval ? (nextSlotByEndpoint.get(t.endpoint) ?? 0) : 0;
      const startAt = Math.max(now, nextSlot, epSlot);
      nextSlot = startAt + minInterval;
      if (epInterval > minInterval) nextSlotByEndpoint.set(t.endpoint, startAt + epInterval);
      const wait = startAt - now;
      if (wait > 0) await sleep(wait);

      const { out, row } = await runOne(t.input, opts);
      // Unreachable target: if the first few trials all fail at the transport level (timeouts,
      // DNS, refused), stop instead of spending hours timing out through the whole plan.
      if (out.transportError) transportErrors++;
      if (done + 1 <= UNREACHABLE_AFTER && transportErrors >= UNREACHABLE_AFTER && !aborted) {
        aborted = new Error(`target unreachable: the first ${UNREACHABLE_AFTER} trials all failed at the transport level (last: ${out.transportError}); aborting the run`);
      }
      const values: NewTrial = {
        testRunId,
        endpoint: t.endpoint,
        mutationType: t.type,
        mutationId: t.id,
        paramName: t.param,
        ...row,
      };
      const [inserted] = await db.insert(schema.trials).values(values).returning();
      results[i] = inserted;
      done++;
      log.debug('exercise', `${t.endpoint} ${t.id} -> ${out.status ?? out.transportError} (${out.latencyMs}ms)`);
      opts.onProgress?.(done, plan.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
  const abortErr = aborted as Error | null; // assigned inside the worker closures; TS cannot see that
  if (abortErr) {
    log.error('exercise', abortErr.message);
    throw abortErr;
  }
  const trials = results.filter((r): r is Trial => !!r);
  const dead = unreachable(trials);
  if (dead) throw new Error(dead);
  const rateLimited = trials.filter((t) => t.errorText === 'rate_limited').length;
  if (rateLimited) log.warn('exercise', `${rateLimited} trial(s) ended rate-limited; claims will skip them`);
  log.info('exercise', `${trials.length} trials logged`);
  return trials;
}
