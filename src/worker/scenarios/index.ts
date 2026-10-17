/**
 * Stage 3b SCENARIOS: use the API the way a program does and check invariants the docs never
 * state. Runs after the battery (whose baseline trials tell us which endpoints answer with a
 * list) and before aggregation; its trials and claims join the run like any other.
 *
 * Scenarios so far: pagination completeness (pagination.ts). Planned, in order: conditional
 * requests (ETag / 304 and what they cost), rate-limit truth, filter composition, list vs detail,
 * sort contract, encoding and boundaries. Each is read-only and account-free.
 */
import type { Db } from '../../db/client.js';
import type { Trial } from '../../db/schema.js';
import type { CandidateClaim } from '../claims.js';
import type { ExerciseOptions } from '../exercise.js';
import { log } from '../log.js';
import { endpointLabel, type EndpointSpec } from '../spec.js';
import type { TargetConfig } from '../target.js';
import { paginationConfig, pagingParams, runPaginationScenario, SCENARIO_VERSION } from './pagination.js';

export { SCENARIO_VERSION };

export interface ScenariosResult {
  trials: Trial[];
  claims: CandidateClaim[];
  requests: number;
  endpoints: string[]; // endpoints a scenario ran on
}

/**
 * Endpoints whose baseline response was a list: a top-level array, or an object with one array
 * field. Read from the trial's recorded arrayLengths (taken before body truncation), so no extra
 * request is spent finding out.
 */
export function listEndpoints(endpoints: EndpointSpec[], trials: Trial[]): EndpointSpec[] {
  return endpoints.filter((ep) => {
    const label = endpointLabel(ep);
    const b = trials.find((t) => t.endpoint === label && t.mutationId === 'baseline');
    if (!b || b.statusCode === null || b.statusCode >= 300) return false;
    const lengths = ((b.response as { arrayLengths?: Record<string, number> } | null)?.arrayLengths ?? {}) as Record<string, number>;
    const keys = Object.keys(lengths);
    return keys.includes('') || keys.length === 1;
  });
}

export async function runScenarios(db: Db, testRunId: number, endpoints: EndpointSpec[], target: TargetConfig, batteryTrials: Trial[], opts: ExerciseOptions): Promise<ScenariosResult> {
  const out: ScenariosResult = { trials: [], claims: [], requests: 0, endpoints: [] };
  const pag = paginationConfig(target);
  if (!pag) {
    log.info('scenario', 'pagination scenario disabled by the target');
    return out;
  }
  const candidates = listEndpoints(endpoints, batteryTrials).filter((ep) => pagingParams(ep));
  if (!candidates.length) {
    log.info('scenario', 'no paginated list endpoints with a working baseline; no scenarios run');
    return out;
  }
  log.info('scenario', `pagination completeness on ${candidates.length} endpoint(s): ${pag.pages} pages of ${pag.page_size}, two walks + one re-read`);
  for (const ep of candidates) {
    try {
      const r = await runPaginationScenario(db, testRunId, ep, target, pag, opts);
      out.trials.push(...r.trials);
      out.claims.push(...r.claims);
      out.requests += r.requests;
      if (r.requests) out.endpoints.push(endpointLabel(ep));
    } catch (e) {
      // A scenario that breaks must not take the run down with it; the battery's claims stand.
      log.warn('scenario', `${endpointLabel(ep)}: pagination scenario failed: ${(e as Error).message}`);
    }
  }
  log.info('scenario', `${out.requests} request(s), ${out.claims.length} candidate claim(s) on ${out.endpoints.length} endpoint(s)`);
  return out;
}
