/**
 * The one piece every scenario shares: send a request, space it politely, log it as a trial
 * (mutation_type "scenario"), and hand back both the stored row and the live outcome (full body,
 * full kept headers) so the scenario can check its invariant on what actually came back rather
 * than on the truncated stored copy.
 */
import type { Db } from '../../db/client.js';
import { schema } from '../../db/client.js';
import type { NewTrial, Trial } from '../../db/schema.js';
import { runOne, type ExerciseOptions } from '../exercise.js';
import type { TrialInput, TrialOutcome } from '../http.js';
import { log } from '../log.js';
import { intervalFor, type TargetConfig } from '../target.js';

export interface ScenarioRequester {
  /** Send one request as part of a scenario; returns the stored trial and the live outcome. */
  send(input: TrialInput, mutationId: string, param?: string | null): Promise<{ trial: Trial; out: TrialOutcome }>;
  /** Requests sent so far. */
  readonly count: number;
  /** Every trial logged by this requester, in order. */
  readonly trials: Trial[];
}

export function makeRequester(db: Db, testRunId: number, endpoint: string, target: TargetConfig, opts: ExerciseOptions): ScenarioRequester {
  const gap = Math.max(opts.minIntervalMs ?? target.rate?.min_interval_ms ?? 150, intervalFor(target, endpoint));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const trials: Trial[] = [];
  let count = 0;
  return {
    get count() {
      return count;
    },
    get trials() {
      return trials;
    },
    async send(input, mutationId, param = null) {
      if (count > 0 && gap > 0) await sleep(gap);
      count++;
      const { out, row } = await runOne(input, opts);
      const values: NewTrial = { testRunId, endpoint, mutationType: 'scenario', mutationId, paramName: param, ...row };
      const [trial] = await db.insert(schema.trials).values(values).returning();
      trials.push(trial);
      log.debug('scenario', `${endpoint} ${mutationId} -> ${out.status ?? out.transportError} (${out.latencyMs}ms)`);
      return { trial, out };
    },
  };
}

/** Milliseconds between two trials' creation, never negative. */
export function msBetween(a: Trial, b: Trial): number {
  return Math.max(0, (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}
