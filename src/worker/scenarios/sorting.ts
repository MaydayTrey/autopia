/**
 * SCENARIO BATTERY, scenario 5: SORT CONTRACT.
 *
 * A program asks for a list sorted a certain way and then relies on the order. What the docs
 * rarely say:
 *   O1  is the page actually ordered by the field the sort key names, in the stated direction?
 *   O2  do the two directions produce opposite orders (asc non-decreasing, desc non-increasing)?
 *   O3  what is the DEFAULT order: which sort key and direction does an unsorted request equal?
 *   O4  does the same sort request return the same order twice (stable between reads)?
 *
 * Sort keys and directions come from the target's optional_values for the endpoint's sort and
 * direction parameters. The item field a sort key refers to is looked up by name (created ->
 * created_at, stars -> stargazers_count, name -> name); when no field matches, only the
 * structural facts are claimed (order changed vs unchanged, stable vs not). As everywhere in
 * the battery, a same-named field is a hint, never a definition: a page that is not ordered by
 * that field is reported as exactly that, not as "ignored". A violation is re-requested once and
 * claimed only when seen twice.
 *
 * Budget per list endpoint: 1 unsorted + per sort key (max 3): one request per direction (2 when
 * a direction parameter exists, else 1), + one repeat of the first sorted page, + repeats on
 * findings. Pages of 20.
 */
import type { Db } from '../../db/client.js';
import type { Trial } from '../../db/schema.js';
import { buildBaseline, valueFor } from '../battery/index.js';
import { scenarioClaimKey, type CandidateClaim } from '../claims.js';
import type { ExerciseOptions } from '../exercise.js';
import type { TrialInput } from '../http.js';
import { log } from '../log.js';
import { endpointLabel, type EndpointSpec, type ParamSpec } from '../spec.js';
import type { TargetConfig } from '../target.js';
import { identityOf, listItems, pagingParams } from './pagination.js';
import { makeRequester } from './runner.js';

export const SORT_PAGE_SIZE = 20;
export const MAX_SORT_KEYS = 3;
const SORT_PARAM = /^(sort|sort_by|sortby|order_by|orderby|ordering|sort_field)$/i;
const DIRECTION_PARAM = /^(direction|order|sort_order|sort_dir|sortdir|dir)$/i;
const ASC = /^(asc|ascending|up|1)$/i;
const DESC = /^(desc|descending|down|-1)$/i;

export interface SortParams {
  sort: ParamSpec;
  direction: ParamSpec | null;
  keys: string[]; // sort values to try, from the target (or the enum when the target gives none)
  directions: string[]; // direction values to try: the enum's asc/desc pair, or []
}

export function sortParams(ep: EndpointSpec, target: TargetConfig): SortParams | null {
  const q = ep.params.filter((p) => p.in === 'query');
  const values = target.optional_values?.[ep.path] ?? {};
  // Several sort-like parameters: prefer the one the target gives a value for, then one whose
  // enum is not just directions (a "sort" that takes asc|desc is a direction, not a key).
  const sortLike = q.filter((p) => SORT_PARAM.test(p.name));
  const sort = sortLike.find((p) => values[p.name] !== undefined) ?? sortLike.find((p) => !(p.enum && p.enum.length && p.enum.every((v) => ASC.test(v) || DESC.test(v)))) ?? sortLike[0];
  if (!sort) return null;
  const direction = q.find((p) => DIRECTION_PARAM.test(p.name)) ?? null;
  const keys = [...new Set([values[sort.name], ...(sort.enum ?? [])].filter((v): v is string => typeof v === 'string' && v.length > 0))].slice(0, MAX_SORT_KEYS);
  if (!keys.length) return null;
  const dirEnum = direction?.enum ?? [];
  const asc = dirEnum.find((v) => ASC.test(v));
  const desc = dirEnum.find((v) => DESC.test(v));
  const directions = direction ? (asc && desc ? [desc, asc] : dirEnum.length ? dirEnum.slice(0, 2) : ['desc', 'asc']) : [];
  return { sort, direction, keys, directions };
}

/** The item field a sort key most plausibly refers to, or null. Exact name first, then the usual suffixes and a few well-known aliases. */
export function sortFieldFor(key: string, item: Record<string, unknown>): string | null {
  const k = key.toLowerCase();
  const alias: Record<string, string[]> = { stars: ['stargazers_count', 'stars', 'star_count'], forks: ['forks_count', 'forks'], popularity: ['popularity', 'score'], comments: ['comments', 'comments_count', 'comment_count'], reactions: ['reactions_count', 'reactions'], interactions: ['interactions_count'], updated: ['updated_at', 'updated', 'modified_at', 'last_modified'], created: ['created_at', 'created'], pushed: ['pushed_at'], date: ['date', 'created_at', 'timestamp'], 'help-wanted-issues': ['open_issues_count'] };
  const candidates = [k, ...(alias[k] ?? []), `${k}_at`, `${k}_count`, `${k}_date`, `${k}At`, `${k}Count`];
  for (const c of candidates) if (c in item && (typeof item[c] === 'string' || typeof item[c] === 'number')) return c;
  return null;
}

/** Is the sequence of values non-decreasing (asc) / non-increasing (desc)? Strings compare lexically, ISO timestamps included; numbers numerically. Nulls break the check (null = unknown). */
export function isOrdered(values: unknown[], dir: 'asc' | 'desc'): boolean | null {
  if (values.length < 2) return null;
  if (values.some((v) => v === null || v === undefined)) return null;
  for (let i = 1; i < values.length; i++) {
    const a = values[i - 1] as string | number;
    const b = values[i] as string | number;
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
    const cmp =
      typeof a === 'number' && typeof b === 'number'
        ? a - b
        : iso.test(String(a)) && iso.test(String(b)) && !Number.isNaN(Date.parse(String(a))) && !Number.isNaN(Date.parse(String(b)))
          ? Date.parse(String(a)) - Date.parse(String(b))
          : String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
    if (dir === 'asc' ? cmp > 0 : cmp < 0) return false;
  }
  return true;
}

export interface SortObs {
  trialId: number;
  status: number | null;
  key: string | null; // null for the unsorted page
  direction: string | null;
  ids: string[];
  items: Record<string, unknown>[];
  isList: boolean;
}

const dirKind = (d: string | null): 'asc' | 'desc' | null => (d === null ? null : ASC.test(d) ? 'asc' : DESC.test(d) ? 'desc' : null);
/** The claim-key parameter for a key/direction pair. A leading "-" (Django-style "-created") is spelled out so it survives the slug and cannot collide with "created". */
const keyParam = (key: string, direction: string | null) => `${key.replace(/^-/, 'minus_')}${direction !== null ? `_${direction}` : ''}`;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export function sortClaims(endpoint: string, sortParam: string, directionParam: string | null, base: SortObs, sorted: SortObs[], repeats: SortObs[], trials: Map<number, { statusCode: number | null }>): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  if (!base.isList || base.status === null || base.status >= 300 || base.ids.length < 2) return out;
  const status = `HTTP ${base.status}`;
  const claim = (check: string, param: string | null, statement: string, evidence: SortObs[], confidence = 0.9): CandidateClaim => {
    const ids = [...new Set(evidence.map((o) => o.trialId))].sort((a, b) => a - b);
    return { claim_key: scenarioClaimKey(check, endpoint, param), statement, endpoint, kind: 'undocumented', param, verdict: 'observes', source: 'scenario', confidence, evidence_trial_ids: ids, expectations: ids.map((id) => ({ trial_id: id, status: trials.get(id)?.statusCode ?? null })), diverges_from_spec: false, spec_says: null };
  };
  const label = (o: SortObs) => `${sortParam}=${o.key}${o.direction !== null && directionParam ? `&${directionParam}=${o.direction}` : ''}`;
  const repeatOf = (o: SortObs) => repeats.find((r) => r.key === o.key && r.direction === o.direction) ?? null;

  // O3: which sorted page equals the unsorted one?
  const dflt = sorted.filter((o) => o.isList && same(o.ids, base.ids));
  if (dflt.length === 1) out.push(claim('sort_default', null, `The default order equals ${label(dflt[0])}: an unsorted request returned the same page in the same order (${status}).`, [base, dflt[0]]));
  else if (dflt.length > 1) out.push(claim('sort_default', null, `The default order equals ${dflt.map(label).join(' and ')}: an unsorted request returned the same page in the same order as each of them (${status}); they are indistinguishable on this page, and the default is one of them.`, [base, ...dflt]));

  for (const o of sorted) {
    if (o.status === null) continue;
    if (o.status >= 400) {
      out.push(claim('sort', keyParam(o.key!, o.direction), `${label(o)} (a documented value) is rejected with HTTP ${o.status}.`, [o], 0.7));
      continue;
    }
    if (!o.isList || o.ids.length < 2) continue;
    const field = sortFieldFor(o.key!, o.items[0]);
    const explicit = dirKind(o.direction);
    const want: 'asc' | 'desc' = explicit ?? (field && isOrdered(o.items.map((it) => it[field]), 'asc') === true ? 'asc' : 'desc');
    const changed = !same(o.ids, base.ids);
    const param = keyParam(o.key!, o.direction);
    if (field) {
      const ordered = isOrdered(o.items.map((it) => it[field]), want);
      if (ordered === true) out.push(claim('sort', param, `${label(o)} orders the page by "${field}" ${want === 'asc' ? 'ascending' : 'descending'} (${status}).${o.direction === null ? ` Without a direction parameter the order is ${want === 'asc' ? 'ascending' : 'descending'}.` : ''}`, [o]));
      else if (ordered === false) {
        const rep = repeatOf(o);
        const again = rep && rep.isList && isOrdered(rep.items.map((it) => it[field]), want) === false;
        if (again) {
          const sibling = sorted.find((s) => s.key === o.key && s !== o && s.isList && s.ids.length >= 2 && dirKind(s.direction) && isOrdered(s.items.map((it) => it[field]), dirKind(s.direction)!) === true);
          const siblingNote = sibling ? ` The other direction, ${label(sibling)}, IS ordered by "${field}".` : '';
          const why = changed ? 'The key sorts by something other than that field here, or only the direction is applied' : 'The key is ignored, or that is the default order';
          out.push(claim('sort', param, `${label(o)} does NOT order the page by "${field}" ${want === 'asc' ? 'ascending' : 'descending'}${changed ? ' although it changes the order relative to the unsorted page' : ', and the page is identical to the unsorted one'} (${status}, seen twice).${siblingNote} ${why}; sort client-side if that field is what you need.`, [base, o, rep, ...(sibling ? [sibling] : [])], field.toLowerCase() === o.key!.toLowerCase() ? 0.85 : 0.7));
        }
        else if (!rep) log.info('scenario', `${endpoint}: ${label(o)} not ordered by ${field} on one read; not claimed`);
      }
      // ordered === null: nulls in the field; say nothing
    } else if (changed) out.push(claim('sort', param, `${label(o)} changes the order of the first page relative to the unsorted one; items carry no field matching "${o.key}", so the ordering could not be checked (${status}).`, [base, o], 0.7));
    else out.push(claim('sort', param, `${label(o)} leaves the first page identical to the unsorted one; items carry no field matching "${o.key}" (${status}). Either it is the default order or the key has no effect.`, [base, o], 0.7));
  }

  // O2: the two directions of the same key disagree with each other.
  for (const key of new Set(sorted.map((o) => o.key))) {
    const a = sorted.find((o) => o.key === key && dirKind(o.direction) === 'asc' && o.isList && o.ids.length >= 2);
    const d = sorted.find((o) => o.key === key && dirKind(o.direction) === 'desc' && o.isList && o.ids.length >= 2);
    if (a && d && same(a.ids, d.ids)) out.push(claim('sort_direction', String(key), `${sortParam}=${key}: ${directionParam}=${a.direction} and ${directionParam}=${d.direction} returned the identical page (${status}): the direction parameter has no effect on this key.`, [a, d], 0.85));
  }

  // O4: stability between two reads of the same sorted page.
  const first = sorted.find((o) => o.isList && o.status !== null && o.status < 300 && o.ids.length >= 2);
  const rep = first ? repeatOf(first) : null;
  if (first && rep && rep.isList) {
    if (same(first.ids, rep.ids)) out.push(claim('sort_stable', null, `${label(first)} read twice a few seconds apart returned the same ids in the same order (${status}): the order is reproducible between reads; new or changed items can still shift later pages.`, [first, rep]));
    else out.push(claim('sort_stable', null, `${label(first)} read twice a few seconds apart did not return the same order (${status}): ties are broken arbitrarily or the list is live; expect items to shift between pages.`, [first, rep]));
  }
  return out;
}

export async function runSortScenario(db: Db, testRunId: number, ep: EndpointSpec, target: TargetConfig, opts: ExerciseOptions): Promise<{ trials: Trial[]; claims: CandidateClaim[]; requests: number }> {
  const label = endpointLabel(ep);
  const sp = sortParams(ep, target);
  if (!sp) return { trials: [], claims: [], requests: 0 };
  const base = buildBaseline(ep, target);
  const paging = pagingParams(ep);
  const sizeParam = paging?.size?.name ?? null;
  const req = makeRequester(db, testRunId, label, target, opts);
  const dirValue = (d: string) => valueFor(sp.direction!, d);

  const inputFor = (key: string | null, direction: string | null): TrialInput => {
    const drop = new Set([sp.sort.name, sp.direction?.name ?? '', sizeParam ?? '']);
    const q = base.input.query.filter(([k]) => !drop.has(k));
    if (sizeParam) q.push([sizeParam, String(SORT_PAGE_SIZE)]);
    if (key !== null) q.push([sp.sort.name, key]);
    if (direction !== null && sp.direction) q.push([sp.direction.name, dirValue(direction)]);
    return { ...base.input, headers: { ...base.input.headers }, query: q };
  };
  const fetch = async (key: string | null, direction: string | null, id: string): Promise<SortObs> => {
    const { trial, out } = await req.send(inputFor(key, direction), id, key === null ? null : sp.sort.name);
    const list = out.status !== null && out.status < 300 ? listItems(out.body) : null;
    const items = list?.items ?? [];
    return { trialId: trial.id, status: out.status, key, direction, ids: items.map(identityOf), items, isList: !!list };
  };

  const baseObs = await fetch(null, null, 'scenario:sort:unsorted');
  if (!baseObs.isList || baseObs.ids.length < 2) return { trials: req.trials, claims: [], requests: req.count };
  const sorted: SortObs[] = [];
  for (const key of sp.keys) {
    if (sp.directions.length) for (const d of sp.directions) sorted.push(await fetch(key, d, `scenario:sort:${key}:${d}`));
    else sorted.push(await fetch(key, null, `scenario:sort:${key}`));
  }
  // One repeat of the first usable sorted page (stability), plus a repeat for every page that failed its field check once.
  const repeats: SortObs[] = [];
  const first = sorted.find((o) => o.isList && o.status !== null && o.status < 300 && o.ids.length >= 2);
  if (first) repeats.push(await fetch(first.key, first.direction, `scenario:sort:${first.key}${first.direction !== null ? `:${first.direction}` : ''}:again`));
  for (const o of sorted) {
    if (!o.isList || o.ids.length < 2 || o === first) continue;
    const field = sortFieldFor(o.key!, o.items[0]);
    const vals = field ? o.items.map((it) => it[field]) : [];
    const failed = field && (dirKind(o.direction) ? isOrdered(vals, dirKind(o.direction)!) === false : isOrdered(vals, 'asc') === false && isOrdered(vals, 'desc') === false);
    if (failed) repeats.push(await fetch(o.key, o.direction, `scenario:sort:${o.key}${o.direction !== null ? `:${o.direction}` : ''}:again`));
  }
  const byId = new Map(req.trials.map((t) => [t.id, t]));
  const claims = sortClaims(label, sp.sort.name, sp.direction?.name ?? null, baseObs, sorted, repeats, byId);
  log.info('scenario', `${label}: sort scenario made ${req.count} request(s), ${claims.length} claim(s)`);
  return { trials: req.trials, claims, requests: req.count };
}
