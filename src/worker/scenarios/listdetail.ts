/**
 * SCENARIO BATTERY, scenario 2: LIST vs DETAIL CONSISTENCY.
 *
 * A program reads a list, then fetches one item's detail. What the docs rarely say:
 *   L1  which fields the detail carries that the list item omits (so the program knows when a
 *       second request is needed) and which the list carries that the detail omits;
 *   L2  whether shared scalar fields agree between the list item and its detail on the same read,
 *       or whether list values are stale or summarized.
 *
 * The detail endpoint is found in the SPEC (not only among the probed endpoints): the list path
 * plus exactly one template segment, e.g. /repos/{owner}/{repo}/issues -> .../issues/{issue_number}.
 * The item field that feeds that segment is chosen by the parameter's name (number, sha/ref, id,
 * name/login) and confirmed by the detail's own identity matching the item's. Two items are
 * checked (first and last of a small page); only facts that hold for both are claimed. Budget:
 * one list page + two detail requests per list endpoint. Statements name field names only.
 */
import type { Db } from '../../db/client.js';
import type { Trial } from '../../db/schema.js';
import { buildBaseline, renderPath } from '../battery/index.js';
import { scenarioClaimKey, type CandidateClaim } from '../claims.js';
import type { ExerciseOptions } from '../exercise.js';
import type { TrialInput } from '../http.js';
import { log } from '../log.js';
import { canonicalJson, endpointLabel, type EndpointSpec, type ParamSpec } from '../spec.js';
import type { TargetConfig } from '../target.js';
import { listItems, pagingParams } from './pagination.js';
import { makeRequester } from './runner.js';

export const LIST_DETAIL_PAGE_SIZE = 5;

/** The detail endpoint of a list endpoint: same path plus one template segment, GET. */
export function detailEndpointFor(list: EndpointSpec, all: EndpointSpec[]): { ep: EndpointSpec; param: ParamSpec } | null {
  const prefix = list.path.replace(/\/+$/, '') + '/';
  for (const ep of all) {
    if (ep.method !== 'GET' || !ep.path.startsWith(prefix)) continue;
    const rest = ep.path.slice(prefix.length);
    const m = rest.match(/^\{([^}/]+)\}$/);
    if (!m) continue;
    const param = ep.params.find((p) => p.in === 'path' && p.name === m[1]);
    if (param) return { ep, param };
  }
  return null;
}

/** Candidate item fields that feed a detail path parameter, by the parameter's name. */
export function idFieldsFor(paramName: string): string[] {
  const n = paramName.toLowerCase();
  if (/number/.test(n)) return ['number', 'id'];
  if (/sha|ref|commit/.test(n)) return ['sha', 'id'];
  if (/(^|_)id$|_id_|^id_/.test(n)) return ['id', 'number'];
  if (/name|login|user|slug|key/.test(n)) return ['login', 'name', 'slug', 'key', 'id'];
  return ['id', 'number', 'sha', 'name', 'key'];
}

/** A value may feed a single path segment only if it is one plain, bounded segment: no slashes, no dot segments, no query or fragment characters. */
export function isPathSegment(v: string): boolean {
  return v.length > 0 && v.length <= 200 && v !== '.' && v !== '..' && !/[\/\\?#\s]/.test(v);
}

/** The value of an item that should feed the detail path parameter, and the field it came from. */
export function idValueFor(item: Record<string, unknown>, paramName: string): { field: string; value: string } | null {
  for (const f of idFieldsFor(paramName)) {
    const v = item[f];
    if (typeof v === 'string' || typeof v === 'number') return { field: f, value: String(v) };
  }
  return null;
}


export interface Comparison {
  trialId: number; // the detail trial
  status: number | null;
  identityAgrees: boolean;
  added: string[]; // top-level keys in the detail, absent from the list item
  missing: string[]; // top-level keys in the list item, absent from the detail
  differing: string[]; // shared keys whose values differ, compared deeply (nested objects and arrays included)
}

export function compareItemToDetail(item: Record<string, unknown>, detail: Record<string, unknown>, idField: string): Omit<Comparison, 'trialId' | 'status'> {
  const li = new Set(Object.keys(item));
  const di = new Set(Object.keys(detail));
  const added = [...di].filter((k) => !li.has(k)).sort();
  const missing = [...li].filter((k) => !di.has(k)).sort();
  const differing = [...li].filter((k) => di.has(k) && canonicalJson(item[k]) !== canonicalJson(detail[k])).sort();
  const identityAgrees = detail[idField] !== undefined && String(detail[idField]) === String(item[idField]);
  return { identityAgrees, added, missing, differing };
}

const both = (a: string[], b: string[]) => a.filter((k) => b.includes(k));
const nameList = (keys: string[], max = 12) => (keys.length <= max ? keys.join(', ') : `${keys.slice(0, max).join(', ')} (${keys.length - max} more)`);

export function listDetailClaims(listEndpoint: string, detailEndpoint: string, listTrialId: number, listStatus: number | null, comps: Comparison[], trials: Map<number, { statusCode: number | null }>): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  const ok = comps.filter((c) => c.status !== null && c.status < 300 && c.identityAgrees);
  if (ok.length < 2) return out; // two confirmed detail reads or nothing
  const [a, b] = ok;
  const claim = (check: string, statement: string, confidence = 0.9): CandidateClaim => {
    const ids = [listTrialId, a.trialId, b.trialId].sort((x, y) => x - y);
    return {
      claim_key: scenarioClaimKey(check, listEndpoint),
      statement,
      endpoint: listEndpoint,
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
  const status = listStatus === a.status ? `list and detail both HTTP ${listStatus}` : `list HTTP ${listStatus}, detail HTTP ${a.status}`;
  const added = both(a.added, b.added);
  const missing = both(a.missing, b.missing);
  const differing = both(a.differing, b.differing);
  const cleanFields = a.added.length === 0 && b.added.length === 0 && a.missing.length === 0 && b.missing.length === 0;
  const cleanValues = a.differing.length === 0 && b.differing.length === 0;

  // Field sets: a finding must show on both items; "no difference" needs both items clean.
  if (added.length && missing.length) out.push(claim('list_detail_fields', `The detail endpoint ${detailEndpoint} returns top-level fields the list items omit: ${nameList(added)}; the list items carry top-level fields the detail omits: ${nameList(missing)} (two items, ${status}). Fetch the detail only for the fields it adds.`));
  else if (added.length) out.push(claim('list_detail_fields', `The detail endpoint ${detailEndpoint} returns top-level fields the list items omit: ${nameList(added)} (two items, ${status}). Fetch the detail only for those; every other top-level field is already in the list item.`));
  else if (missing.length) out.push(claim('list_detail_fields', `The detail endpoint ${detailEndpoint} adds no top-level field beyond the list item and omits ${nameList(missing)} that the list items carry (two items, ${status}).`));
  else if (cleanFields) out.push(claim('list_detail_fields', `The detail endpoint ${detailEndpoint} adds no top-level field beyond the list item (two items, ${status}): a second request adds no field.`));
  else log.info('scenario', `${listEndpoint}: field differences seen on one item only; not claimed`);

  // Values: compared deeply on every shared field.
  if (differing.length) out.push(claim('list_detail_values', `Fields whose value or type differs between a list item and its detail read seconds later: ${nameList(differing)} (on both items, ${status}). Read those from the detail; the list value is stale, a summary, or differently typed.`));
  else if (cleanValues) out.push(claim('list_detail_values', `On both items, every field shared by the list item and its detail had the same value, nested contents included (${status}): list values matched a fresh detail read.`));
  else log.info('scenario', `${listEndpoint}: value differences seen on one item only; not claimed`);
  return out;
}

export async function runListDetailScenario(db: Db, testRunId: number, list: EndpointSpec, allEndpoints: EndpointSpec[], target: TargetConfig, opts: ExerciseOptions): Promise<{ trials: Trial[]; claims: CandidateClaim[]; requests: number }> {
  const label = endpointLabel(list);
  const detail = detailEndpointFor(list, allEndpoints);
  if (!detail) return { trials: [], claims: [], requests: 0 };
  if (detail.ep.server !== list.server) {
    log.info('scenario', `${label}: detail endpoint is on another server (${detail.ep.server}); list/detail skipped`);
    return { trials: [], claims: [], requests: 0 };
  }
  const base = buildBaseline(list, target);
  const paging = pagingParams(list);
  const req = makeRequester(db, testRunId, label, target, opts);

  const q = base.input.query.filter(([k]) => k !== paging?.size?.name);
  if (paging?.size) q.push([paging.size.name, String(LIST_DETAIL_PAGE_SIZE)]);
  const listReq = await req.send({ ...base.input, headers: { ...base.input.headers }, query: q }, 'scenario:listdetail:list');
  const listed = listReq.out.status !== null && listReq.out.status < 300 ? listItems(listReq.out.body) : null;
  if (!listed || listed.items.length < 2) return { trials: req.trials, claims: [], requests: req.count }; // two items or no claim
  const picks = [listed.items[0], listed.items[listed.items.length - 1]];
  const idvs = picks.map((it) => idValueFor(it, detail.param.name));
  if (idvs[0] && idvs[1] && idvs[0].value === idvs[1].value) {
    log.info('scenario', `${label}: first and last items share ${idvs[0].field}=${idvs[0].value}; list/detail skipped`);
    return { trials: req.trials, claims: [], requests: req.count };
  }

  const detailBase = buildBaseline(detail.ep, target);
  const comps: Comparison[] = [];
  for (const item of picks) {
    const idv = idValueFor(item, detail.param.name);
    if (idv && !isPathSegment(idv.value)) {
      log.info('scenario', `${label}: item ${idv.field} is not a plain path segment; list/detail skipped`);
      break;
    }
    if (!idv) {
      log.info('scenario', `${label}: no item field feeds ${detail.param.name}; list/detail skipped`);
      break;
    }
    // The detail's other path values (owner, repo) come from the list's baseline, the id from the item.
    const pathValues = { ...detailBase.pathValues, ...base.pathValues, [detail.param.name]: idv.value };
    const input: TrialInput = { method: 'GET', url: detail.ep.server + renderPath(detail.ep.path, pathValues), query: [...detailBase.input.query], headers: { ...detailBase.input.headers, ...base.input.headers }, pathParams: pathValues };
    const r = await req.send(input, `scenario:listdetail:detail:${idv.field}`, detail.param.name);
    const body = r.out.body;
    if (r.out.status !== null && r.out.status < 300 && body && typeof body === 'object' && !Array.isArray(body)) {
      comps.push({ trialId: r.trial.id, status: r.out.status, ...compareItemToDetail(item, body as Record<string, unknown>, idv.field) });
    } else comps.push({ trialId: r.trial.id, status: r.out.status, identityAgrees: false, added: [], missing: [], differing: [] });
  }
  const byId = new Map(req.trials.map((t) => [t.id, t]));
  const claims = listDetailClaims(label, endpointLabel(detail.ep), listReq.trial.id, listReq.out.status, comps, byId);
  log.info('scenario', `${label}: list/detail scenario made ${req.count} request(s), ${claims.length} claim(s)`);
  return { trials: req.trials, claims, requests: req.count };
}
