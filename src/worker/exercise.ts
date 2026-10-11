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
import { endpointLabel, type EndpointSpec } from './spec.js';
import type { TargetConfig } from './target.js';

export interface ExerciseOptions {
  maxTrials?: number;
  concurrency?: number;
  minIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
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

/** Execute one trial input and shape it as a DB row (no insert). Reused by VERIFY. */
export async function runOne(input: TrialInput, opts: ExerciseOptions) {
  const out = await execute(input, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, sleep: opts.sleep });
  return {
    out,
    row: {
      input: input as unknown as object,
      inputHash: hashInput(input),
      response: { status: out.status, headers: out.headers, body: truncateBody(out.body), bodyKind: out.bodyKind } as object,
      signature: out.signature as unknown as object,
      statusCode: out.status,
      errorText: out.transportError ?? (out.rateLimited ? 'rate_limited' : out.signature.errorMessage),
      latencyMs: out.latencyMs,
    },
  };
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

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= plan.length) return;
      const t = plan[i];
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + minInterval;
      if (wait > 0) await sleep(wait);

      const { out, row } = await runOne(t.input, opts);
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
  const trials = results.filter((r): r is Trial => !!r);
  const rateLimited = trials.filter((t) => t.errorText === 'rate_limited').length;
  if (rateLimited) log.warn('exercise', `${rateLimited} trial(s) ended rate-limited; claims will skip them`);
  log.info('exercise', `${trials.length} trials logged`);
  return trials;
}
