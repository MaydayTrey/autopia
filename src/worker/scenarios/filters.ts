/**
 * SCENARIO BATTERY, scenario 4: FILTER COMPOSITION.
 *
 * A program filters a list; the docs list the parameters and stop. What a program needs to know:
 *   F1  is each filter honored on the items it returns (every item on the page matches the field
 *       the filter names), or silently ignored?
 *   F2  does a filter change anything at all (the first page identical to the unfiltered one)?
 *   F3  do two filters compose: is the combined result inside each filter's own result, and do
 *       the items still match both fields? Or does adding one filter disable the other, or make
 *       the combination return nothing although items match both individually?
 *
 * Soundness on partial pages: a single filter's result is only a reference set when it was
 * COMPLETE (shorter than the page size and no rel="next"); otherwise only the field checks apply,
 * which hold on any page. A finding (not honored, combination inconsistent) is re-requested once
 * and claimed only when it shows twice.
 *
 * Budget per list endpoint: 1 unfiltered + one per filter (max 4) + one per pair (max 3), plus
 * one repeat per finding. Filters come from the target's optional_values; paging and sorting
 * parameters are not filters.
 */
import type { Db } from '../../db/client.js';
import type { Trial } from '../../db/schema.js';
import { buildBaseline, valueFor } from '../battery/index.js';
import { scenarioClaimKey, type CandidateClaim } from '../claims.js';
import type { ExerciseOptions } from '../exercise.js';
import type { TrialInput } from '../http.js';
import { log } from '../log.js';
import { endpointLabel, type EndpointSpec, type ParamSpec } from '../spec.js';
import { isSecretParam } from '../redact.js';
import type { TargetConfig } from '../target.js';
import { identityOf, listItems, pagingParams, parseLinkHeader } from './pagination.js';
import { makeRequester } from './runner.js';

export const DEFAULT_FILTER_PAGE_SIZE = 20;
export const DEFAULT_MAX_FILTERS = 4;
const NOT_FILTERS = /^(page|page_number|pagenumber|p|per_page|per-page|perpage|page_size|page-size|pagesize|limit|count|size|offset|cursor|sort|order|direction|order_by|sort_by|orderby|sortby|api[-_]?key|apikey|key|token|access[-_]?token|auth|format|fields|expand|include)$/i;

export interface FilterConfig {
  page_size: number;
  max_filters: number;
}

export function filterConfig(target: TargetConfig): FilterConfig | null {
  const s = target.scenarios?.filters;
  if (s === false) return null;
  const num = (v: unknown, dflt: number) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? dflt : Math.floor(Number(v)));
  return { page_size: Math.max(5, Math.min(100, num(s?.page_size, DEFAULT_FILTER_PAGE_SIZE))), max_filters: Math.max(1, Math.min(6, num(s?.max_filters, DEFAULT_MAX_FILTERS))) };
}

/** The optional query parameters that act as filters and have a known-good value in the target, in spec order. */
export function filterParams(ep: EndpointSpec, target: TargetConfig): { param: ParamSpec; value: string }[] {
  const values = target.optional_values?.[ep.path] ?? {};
  return ep.params.filter((p) => p.in === 'query' && !p.required && !NOT_FILTERS.test(p.name) && !isSecretParam(p.name) && values[p.name] !== undefined).map((p) => ({ param: p, value: valueFor(p, values[p.name]) }));
}

/**
 * Does an item match a filter, judged by a field of the same name? true / false, or null when the
 * item has no such field (the filter is then not checkable on items). Objects match on login,
 * name, id or key; arrays match when any element matches; a "*" value matches anything present.
 */
export function fieldMatches(item: Record<string, unknown>, name: string, value: string): boolean | null {
  if (!(name in item)) return null;
  const v = item[name];
  if (value === '*') return v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0);
  const eq = (x: unknown, want: string): boolean => {
    if (x === null || x === undefined) return false;
    if (typeof x === 'object') {
      const o = x as Record<string, unknown>;
      return ['login', 'name', 'id', 'key', 'slug'].some((k) => o[k] !== undefined && String(o[k]).toLowerCase() === want.toLowerCase());
    }
    return String(x).toLowerCase() === want.toLowerCase();
  };
  // An array field (labels) matches a comma-separated filter when every wanted value is present.
  if (Array.isArray(v)) return value.split(',').every((want) => v.some((el) => eq(el, want)));
  return eq(v, value);
}

export interface FilterObs {
  trialId: number;
  status: number | null;
  filters: Record<string, string>; // {} for the unfiltered page
  ids: string[];
  items: Record<string, unknown>[];
  complete: boolean; // the whole result fit on this page
  isList: boolean;
}

/** Field check over a page: how many items match, how many do not, how many could not be judged. */
export function pageFieldCheck(obs: FilterObs, name: string, value: string): { match: number; mismatch: number; unknown: number } {
  let match = 0,
    mismatch = 0,
    unknown = 0;
  for (const it of obs.items) {
    const m = fieldMatches(it, name, value);
    if (m === null) unknown++;
    else if (m) match++;
    else mismatch++;
  }
  return { match, mismatch, unknown };
}

const sameSeq = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const keyOf = (filters: Record<string, string>) => Object.keys(filters).sort().join('+');

/**
 * Claims from one unfiltered page, one page per filter (with an optional repeat), and one page per
 * pair (with an optional repeat). Pure.
 */
export function filterClaims(endpoint: string, base: FilterObs, singles: { obs: FilterObs; again: FilterObs | null }[], pairs: { obs: FilterObs; again: FilterObs | null }[], trials: Map<number, { statusCode: number | null }>): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  if (!base.isList || base.status === null || base.status >= 300) return out;
  const status = `HTTP ${base.status}`;
  const claim = (check: string, param: string | null, statement: string, evidence: FilterObs[], confidence = 0.9): CandidateClaim => {
    const ids = [...new Set(evidence.map((o) => o.trialId))].sort((a, b) => a - b);
    return {
      claim_key: scenarioClaimKey(check, endpoint, param),
      statement,
      endpoint,
      kind: 'undocumented',
      param,
      verdict: 'observes',
      source: 'scenario',
      confidence,
      evidence_trial_ids: ids,
      expectations: ids.map((id) => ({ trial_id: id, status: trials.get(id)?.statusCode ?? null })),
      diverges_from_spec: false,
      spec_says: null,
    };
  };
  const fv = (f: Record<string, string>) => Object.entries(f).map(([k, v]) => `"${k}"=${JSON.stringify(v)}`).join(' with ');
  const bySingle = new Map<string, FilterObs>();
  const honored = new Set<string>(); // filters whose single-filter field check passed: only these are field-checked inside combinations

  for (const { obs, again } of singles) {
    const [name, value] = Object.entries(obs.filters)[0];
    if (obs.status !== null && obs.status >= 400) {
      out.push(claim('filter', name, `Filter ${fv(obs.filters)} (the target's own known-good value) is rejected with HTTP ${obs.status}; it cannot be checked as a filter.`, [obs], 0.6));
      continue;
    }
    if (!obs.isList) continue;
    bySingle.set(name, obs);
    const fc = pageFieldCheck(obs, name, value);
    const checkable = fc.match + fc.mismatch > 0 && fc.unknown === 0;
    const identical = sameSeq(obs.ids, base.ids);
    if (checkable && fc.mismatch === 0) {
      honored.add(name);
      out.push(claim('filter', name, `Filter ${fv(obs.filters)} is honored: every item on the first page matches on field "${name}"${identical ? ', and the page is identical to the unfiltered one, so every unfiltered item already matched' : ''} (${status}).`, [base, obs]));
    } else if (checkable && fc.mismatch > 0) {
      // A same-named item field is a hint, not a definition: GitHub's commits "sha" means "start
      // listing from this ref", while each item's sha is its own hash. So a mismatch never reads as
      // "not honored"; it reads as what was observed, and the page comparison carries the meaning.
      const confirmed = again && again.isList && pageFieldCheck(again, name, value).mismatch > 0;
      if (!confirmed) log.info('scenario', `${endpoint}: filter ${name} mismatch seen once only; not claimed`);
      else if (identical) out.push(claim('filter', name, `Filter ${fv(obs.filters)} has no visible effect: the first page is identical to the unfiltered one and none of its items has "${name}" equal to that value (${status}, seen twice). The value is either the default or the parameter is ignored; it does not select items by their "${name}" field.`, [base, obs, again!], 0.8));
      else out.push(claim('filter', name, `Filter ${fv(obs.filters)} changes the result but does not select items by their "${name}" field: returned items have a different "${name}" (${status}, seen twice). The parameter means something else than the item field of the same name.`, [base, obs, again!], 0.8));
    } else if (identical) {
      out.push(claim('filter', name, `Filter ${fv(obs.filters)} leaves the first page identical to the unfiltered one (same ids, same order; items carry no "${name}" field to check against): either every item already matched or the parameter has no effect (${status}).`, [base, obs], 0.7));
    } else if (obs.ids.length === 0) {
      // An empty result for the target's value says something about the data, not the API.
      log.info('scenario', `${endpoint}: filter ${name} returned nothing for the target's value; not claimed`);
    } else {
      out.push(claim('filter', name, `Filter ${fv(obs.filters)} changes the result (a different first page); items carry no "${name}" field, so correctness is not checkable here (${status}).`, [base, obs], 0.7));
    }
  }

  for (const { obs, again } of pairs) {
    const names = Object.keys(obs.filters);
    const key = keyOf(obs.filters);
    if (obs.status !== null && obs.status >= 400) {
      const each = names.every((n) => bySingle.has(n));
      if (each) out.push(claim('filter_combo', key, `Combining ${fv(obs.filters)} is rejected with HTTP ${obs.status} although each filter alone is accepted: the two cannot be sent together.`, [obs, ...names.map((n) => bySingle.get(n)!)]));
      continue;
    }
    if (!obs.isList) continue;
    const refs = names.map((n) => bySingle.get(n)).filter((o): o is FilterObs => !!o && o.isList);
    const problems: string[] = [];
    const problemsAgain: string[] = [];
    const judge = (o: FilterObs, into: string[]) => {
      // Set containment, against complete single results only.
      for (const r of refs) {
        if (!r.complete) continue;
        const [n] = Object.keys(r.filters);
        const outside = o.ids.filter((id) => !r.ids.includes(id));
        if (outside.length) into.push(`items appear that are not in the result of "${n}" alone, so "${n}" is disabled by the combination`);
      }
      // Empty combination while a non-empty intersection exists.
      if (o.ids.length === 0 && refs.length === names.length && refs.every((r) => r.complete)) {
        const inter = refs[0].ids.filter((id) => refs.slice(1).every((r) => r.ids.includes(id)));
        if (inter.length) into.push(`the combination returns nothing although items match both filters individually`);
      }
      // Field agreement under the combination, only for filters whose own check established that
      // the field is what the parameter selects on.
      for (const n of names.filter((n) => honored.has(n))) {
        const fc = pageFieldCheck(o, n, obs.filters[n]);
        if (fc.unknown === 0 && fc.mismatch > 0) into.push(`returned items do not match "${n}"`);
      }
    };
    judge(obs, problems);
    if (problems.length && again && again.isList) judge(again, problemsAgain);
    if (problems.length === 0) {
      if (obs.ids.length === 0) {
        log.info('scenario', `${endpoint}: combination ${key} returned nothing and showed no problem; vacuous, not claimed`);
        continue;
      }
      const contained = refs.filter((r) => r.complete).map((r) => `"${Object.keys(r.filters)[0]}"`);
      const fields = names.filter((n) => honored.has(n)).map((n) => `"${n}"`);
      if (!contained.length && !fields.length) {
        log.info('scenario', `${endpoint}: combination ${key} has no complete reference and no checkable field; nothing to claim`);
        continue;
      }
      out.push(claim('filter_combo', key, `Combining ${fv(obs.filters)} is consistent: a non-empty result${contained.length ? `, all within the result of ${contained.join(' and ')} alone` : ''}${fields.length ? `, every item matching ${fields.join(' and ')}` : ''} (${status}).`, [obs, ...refs]));
    } else if (problemsAgain.length) {
      out.push(claim('filter_combo', key, `Combining ${fv(obs.filters)} is NOT consistent: ${[...new Set(problems)].join('; ')} (${status}, seen twice). Apply one filter server-side and the other client-side.`, [obs, again!, ...refs]));
    } else log.info('scenario', `${endpoint}: combination ${key} inconsistent once only; not claimed`);
  }
  return out;
}

export async function runFilterScenario(db: Db, testRunId: number, ep: EndpointSpec, target: TargetConfig, cfg: FilterConfig, opts: ExerciseOptions): Promise<{ trials: Trial[]; claims: CandidateClaim[]; requests: number }> {
  const label = endpointLabel(ep);
  const filters = filterParams(ep, target).slice(0, cfg.max_filters);
  if (!filters.length) return { trials: [], claims: [], requests: 0 };
  const base = buildBaseline(ep, target);
  const paging = pagingParams(ep);
  const sizeParam = paging?.size?.name ?? ep.params.find((p) => p.in === 'query' && /^(per_page|per-page|page_size|limit)$/i.test(p.name))?.name ?? null;
  const req = makeRequester(db, testRunId, label, target, opts);

  const inputFor = (f: Record<string, string>): TrialInput => {
    const names = new Set(Object.keys(f));
    const q = base.input.query.filter(([k]) => !names.has(k) && k !== sizeParam);
    if (sizeParam) q.push([sizeParam, String(cfg.page_size)]);
    for (const [k, v] of Object.entries(f)) q.push([k, v]);
    return { ...base.input, headers: { ...base.input.headers }, query: q };
  };
  const fetch = async (f: Record<string, string>, id: string): Promise<FilterObs> => {
    const { trial, out } = await req.send(inputFor(f), id, Object.keys(f)[0] ?? null);
    const list = out.status !== null && out.status < 300 ? listItems(out.body) : null;
    const link = parseLinkHeader(out.headers['link']);
    const items = list?.items ?? [];
    return { trialId: trial.id, status: out.status, filters: f, ids: items.map(identityOf), items, complete: !!list && items.length < cfg.page_size && !link.next, isList: !!list };
  };

  const baseObs = await fetch({}, 'scenario:filters:unfiltered');
  if (!baseObs.isList) return { trials: req.trials, claims: [], requests: req.count };

  const singles: { obs: FilterObs; again: FilterObs | null }[] = [];
  for (const { param, value } of filters) {
    const obs = await fetch({ [param.name]: value }, `scenario:filters:${param.name}`);
    let again: FilterObs | null = null;
    if (obs.isList && pageFieldCheck(obs, param.name, value).mismatch > 0) again = await fetch({ [param.name]: value }, `scenario:filters:${param.name}:again`);
    singles.push({ obs, again });
  }
  const usable = filters.filter((f) => singles.find((s) => Object.keys(s.obs.filters)[0] === f.param.name)?.obs.isList).slice(0, 3);
  const pairs: { obs: FilterObs; again: FilterObs | null }[] = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const f = { [usable[i].param.name]: usable[i].value, [usable[j].param.name]: usable[j].value };
      const obs = await fetch(f, `scenario:filters:${usable[i].param.name}+${usable[j].param.name}`);
      // Decide on a repeat with a dry judgement against the singles seen so far.
      let again: FilterObs | null = null;
      // A dry judgement with the observation standing in for its own repeat: a NOT-consistent claim
      // means a problem was found once, which earns the real repeat.
      const probe = filterClaims(label, baseObs, singles, [{ obs, again: obs }], new Map(req.trials.map((t) => [t.id, t])));
      const needsRepeat = probe.some((c) => /filter_combo/.test(c.claim_key) && /NOT consistent/.test(c.statement));
      if (needsRepeat) again = await fetch(f, `scenario:filters:${usable[i].param.name}+${usable[j].param.name}:again`);
      pairs.push({ obs, again });
    }
  }
  const byId = new Map(req.trials.map((t) => [t.id, t]));
  const claims = filterClaims(label, baseObs, singles, pairs, byId);
  log.info('scenario', `${label}: filter scenario made ${req.count} request(s), ${claims.length} claim(s)`);
  return { trials: req.trials, claims, requests: req.count };
}
