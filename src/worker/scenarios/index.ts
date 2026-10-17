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
import { runConditionalScenario } from './conditional.js';
import { filterConfig, filterParams, runFilterScenario } from './filters.js';
import { paginationConfig, pagingParams, runPaginationScenario, SCENARIO_VERSION } from './pagination.js';

export { SCENARIO_VERSION };

/** Scenarios run on at most this many endpoints per target per run: a 200-endpoint spec must not turn into 800 nightly requests. */
export const MAX_SCENARIO_ENDPOINTS = 25;

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

/** Endpoints whose baseline succeeded (2xx), whatever shape it returned. */
export function workingEndpoints(endpoints: EndpointSpec[], trials: Trial[]): EndpointSpec[] {
  return endpoints.filter((ep) => {
    const b = trials.find((t) => t.endpoint === endpointLabel(ep) && t.mutationId === 'baseline');
    return !!b && b.statusCode !== null && b.statusCode < 300;
  });
}

export async function runScenarios(db: Db, testRunId: number, endpoints: EndpointSpec[], target: TargetConfig, batteryTrials: Trial[], opts: ExerciseOptions): Promise<ScenariosResult> {
  const out: ScenariosResult = { trials: [], claims: [], requests: 0, endpoints: [] };
  const ran = new Set<string>();
  const take = (ep: EndpointSpec, r: { trials: Trial[]; claims: CandidateClaim[]; requests: number }) => {
    out.trials.push(...r.trials);
    out.claims.push(...r.claims);
    out.requests += r.requests;
    if (r.requests) ran.add(endpointLabel(ep));
  };

  // Scenario 1: pagination completeness, on paginated list endpoints.
  const pag = paginationConfig(target);
  if (!pag) log.info('scenario', 'pagination scenario disabled by the target');
  else {
    const candidates = listEndpoints(endpoints, batteryTrials).filter((ep) => pagingParams(ep)).slice(0, MAX_SCENARIO_ENDPOINTS);
    if (!candidates.length) log.info('scenario', 'no paginated list endpoints with a working baseline; pagination scenario skipped');
    else log.info('scenario', `pagination completeness on ${candidates.length} endpoint(s): ${pag.pages} pages of ${pag.page_size}, two walks + one re-read`);
    for (const ep of candidates) {
      try {
        take(ep, await runPaginationScenario(db, testRunId, ep, target, pag, opts));
      } catch (e) {
        // A scenario that breaks must not take the run down with it; the battery's claims stand.
        log.warn('scenario', `${endpointLabel(ep)}: pagination scenario failed: ${(e as Error).message}`);
      }
    }
  }

  // Scenario 4: filter composition, on list endpoints that have filter parameters with known-good values.
  const flt = filterConfig(target);
  if (!flt) log.info('scenario', 'filter scenario disabled by the target');
  else {
    const candidates = listEndpoints(endpoints, batteryTrials).filter((ep) => filterParams(ep, target).length > 0).slice(0, MAX_SCENARIO_ENDPOINTS);
    if (candidates.length) log.info('scenario', `filter composition on ${candidates.length} endpoint(s): up to ${flt.max_filters} filters, pages of ${flt.page_size}`);
    for (const ep of candidates) {
      try {
        take(ep, await runFilterScenario(db, testRunId, ep, target, flt, opts));
      } catch (e) {
        log.warn('scenario', `${endpointLabel(ep)}: filter scenario failed: ${(e as Error).message}`);
      }
    }
  }

  // Scenarios 3 + 6: conditional requests and rate-limit accounting, on every working endpoint.
  if (target.scenarios?.conditional === false) log.info('scenario', 'conditional-request scenario disabled by the target');
  else {
    const candidates = workingEndpoints(endpoints, batteryTrials).slice(0, MAX_SCENARIO_ENDPOINTS);
    if (candidates.length) log.info('scenario', `conditional requests + rate-limit accounting on ${candidates.length} endpoint(s): up to 4 requests each`);
    for (const ep of candidates) {
      try {
        take(ep, await runConditionalScenario(db, testRunId, ep, target, opts));
      } catch (e) {
        log.warn('scenario', `${endpointLabel(ep)}: conditional scenario failed: ${(e as Error).message}`);
      }
    }
  }
  out.endpoints = [...ran];
  log.info('scenario', `${out.requests} request(s), ${out.claims.length} candidate claim(s) on ${out.endpoints.length} endpoint(s)`);
  return out;
}
