/**
 * SCENARIO BATTERY, scenario 1: PAGINATION COMPLETENESS.
 *
 * The battery mutates one parameter of one request and judges the answer against the spec. A
 * scenario uses the API the way a program does, several requests with state flowing between
 * them, and judges the result against an INVARIANT that must hold for any sane API, so it needs
 * no documentation to compare against. For a paginated list:
 *
 *   I1  walking pages 1..K by number returns each item exactly once;
 *   I2  following the Link header's rel="next" chain visits the same pages as counting up;
 *   I3  a page read twice a few seconds apart returns the same items in the same order;
 *   I4  every page before the last holds exactly the requested page size;
 *   I5  the list ends cleanly (a short or empty page, and no rel="next" on it).
 *
 * Every request is logged as a trial (mutation_type "scenario"); every claim cites those trials
 * and states their HTTP status, so VERIFY reproduces them like any other evidence. A finding
 * (duplicates, disagreement) is only claimed when BOTH independent walks show it: the second walk
 * is the reproduction of the invariant itself, not just of the requests.
 *
 * Read-only, small (2 x pages requests per endpoint, page size 5 by default), spaced by the
 * target's rate settings. Nothing here needs an account.
 */
import type { Db } from '../../db/client.js';
import type { Trial } from '../../db/schema.js';
import { buildBaseline } from '../battery/index.js';
import { scenarioClaimKey, type CandidateClaim } from '../claims.js';
import type { ExerciseOptions } from '../exercise.js';
import type { TrialInput } from '../http.js';
import { log } from '../log.js';
import { canonicalJson, endpointLabel, sha256, type EndpointSpec, type ParamSpec } from '../spec.js';
import type { TargetConfig } from '../target.js';
import { makeRequester } from './runner.js';

export const SCENARIO_VERSION = '0.1.0';
export const DEFAULT_PAGES = 4;
export const DEFAULT_PAGE_SIZE = 5;

const PAGE_PARAM = /^(page|page_number|pagenumber|p)$/i;
const SIZE_PARAM = /^(per_page|per-page|perpage|page_size|page-size|pagesize|limit|count|size)$/i;
const ID_FIELDS = ['id', 'sha', 'node_id', 'uuid', 'key', 'slug', 'number', 'name'];

export interface PaginationConfig {
  pages: number;
  page_size: number;
}

export function paginationConfig(target: TargetConfig): PaginationConfig | null {
  const s = target.scenarios?.pagination;
  if (s === false) return null;
  const num = (v: unknown, dflt: number) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? dflt : Math.floor(Number(v)));
  const pages = Math.max(2, Math.min(10, num(s?.pages, DEFAULT_PAGES)));
  const page_size = Math.max(1, Math.min(100, num(s?.page_size, DEFAULT_PAGE_SIZE)));
  return { pages, page_size };
}

/** The page-number and page-size query parameters of an endpoint, if it has a page number at all. */
export function pagingParams(ep: EndpointSpec): { page: ParamSpec; size: ParamSpec | null } | null {
  const q = ep.params.filter((p) => p.in === 'query');
  const page = q.find((p) => PAGE_PARAM.test(p.name));
  if (!page) return null;
  const size = q.find((p) => SIZE_PARAM.test(p.name)) ?? null;
  return { page, size };
}

/**
 * The list inside a response body: a top-level array of objects, or an object with exactly one
 * array-of-objects field (GitHub search: {total_count, items}). Null when the body is not a list.
 */
export function listItems(body: unknown): { items: Record<string, unknown>[]; field: string | null; total: number | null } | null {
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  if (Array.isArray(body)) return body.every(isObj) || body.length === 0 ? { items: body as Record<string, unknown>[], field: null, total: null } : null;
  if (!isObj(body)) return null;
  const arrays = Object.entries(body).filter(([, v]) => Array.isArray(v));
  if (arrays.length !== 1) return null;
  const [field, v] = arrays[0] as [string, unknown[]];
  if (!(v.every(isObj) || v.length === 0)) return null;
  const totalKey = Object.keys(body).find((k) => /^(total|total_count|totalcount|count|total_results)$/i.test(k));
  const total = totalKey && typeof body[totalKey] === 'number' ? (body[totalKey] as number) : null;
  return { items: v as Record<string, unknown>[], field, total };
}

/** A stable identity for a list item: its id-like field, else a hash of the whole item. */
export function identityOf(item: Record<string, unknown>): string {
  for (const f of ID_FIELDS) {
    const v = item[f];
    if (typeof v === 'string' || typeof v === 'number') return `${f}=${v}`;
  }
  return `hash=${sha256(canonicalJson(item)).slice(0, 16)}`;
}

/** rel -> url from an RFC 8288 Link header. */
export function parseLinkHeader(h: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const part of h.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*(.*)$/);
    if (!m) continue;
    const rel = m[2].match(/rel\s*=\s*"?([^";,]+)"?/i);
    if (rel) out[rel[1].toLowerCase()] = m[1].trim();
  }
  return out;
}

/** A TrialInput for an absolute URL (from a Link header), carrying the headers of a known-good input. */
export function inputFromUrl(url: string, like: TrialInput): TrialInput {
  const u = new URL(url, like.url); // relative Link URLs are legal; they resolve against the endpoint
  const b = new URL(like.url);
  if (!/^https?:$/.test(u.protocol) || u.host !== b.host) throw new Error(`Link URL leaves the endpoint's origin: ${u.origin}`);
  const query: [string, string][] = [...u.searchParams.entries()];
  return { method: 'GET', url: `${u.origin}${u.pathname}`, query, headers: { ...like.headers }, ...(like.pathParams ? { pathParams: { ...like.pathParams } } : {}) };
}

export interface PageObs {
  trialId: number;
  status: number | null;
  page: number; // 1-based position in the walk
  ids: string[];
  link: Record<string, string>;
  isList: boolean;
}

export interface WalkResult {
  byNumber: PageObs[];
  byLink: PageObs[];
  again: PageObs | null; // page 2 by number, read a second time
  againAfterMs: number;
  endSeen: boolean; // a page shorter than the page size, or empty, within the budget
}

const dupes = (pages: PageObs[]): { count: number; sample: { id: string; pages: number[] } | null } => {
  const seen = new Map<string, number[]>();
  for (const p of pages) for (const id of p.ids) seen.set(id, [...(seen.get(id) ?? []), p.page]);
  const d = [...seen].filter(([, ps]) => ps.length > 1);
  return { count: d.length, sample: d.length ? { id: d[0][0].replace(/^[a-z_]+=/, ''), pages: d[0][1] } : null };
};
const okPages = (pages: PageObs[]) => pages.filter((p) => p.status !== null && p.status >= 200 && p.status < 300 && p.isList);

/**
 * Turn two walks (and a re-read) into claims. Pure; the runner supplies the observations.
 * Each claim cites the trials it rests on and records their statuses for the evidence check.
 */
export function paginationClaims(endpoint: string, pageParam: string, sizeParam: string | null, size: number, w: WalkResult, trials: Map<number, { statusCode: number | null }>): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  const A = okPages(w.byNumber);
  if (A.length === 0) return out; // the first page did not come back as a list: nothing to say
  const B = okPages(w.byLink);
  const status = `HTTP ${A[0].status}`;
  const sizeText = sizeParam ? `${sizeParam}=${size}` : `the default page size (${A[0].ids.length})`;
  const claim = (check: string, statement: string, evidence: PageObs[], confidence = 0.9): CandidateClaim => {
    const ids = [...new Set(evidence.map((p) => p.trialId))].sort((a, b) => a - b);
    return {
      claim_key: scenarioClaimKey(check, endpoint),
      statement,
      endpoint,
      kind: 'pagination',
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

  const items = (n: number) => `${n} item${n === 1 ? '' : 's'}`;
  const filled = A.filter((p) => p.ids.length > 0); // an empty page is the end marker, not a page of the walk
  const totalA = A.reduce((n, p) => n + p.ids.length, 0);
  const dA = dupes(A);
  const walked = `${filled.length} page(s) of ${sizeText} by "${pageParam}"`;
  const secondHasItems = A.length >= 2 && A[1].ids.length > 0;

  // I1 uniqueness, reproduced by the Link walk when there is one.
  if (filled.length >= 2) {
    const dB = B.length >= 2 ? dupes(B) : null;
    if (dA.count === 0 && (dB === null || dB.count === 0)) {
      out.push(claim('pagination_unique', `Walking ${walked} returns each item once (no id repeats across pages)${B.length >= 2 ? ', on both a numbered walk and a Link-header walk' : ''} (${status}).`, [...A, ...B]));
    } else if (dA.count > 0 && dB !== null && dB.count > 0) {
      const s = dA.sample!;
      out.push(claim('pagination_unique', `Walking ${walked} repeats items across pages: ids from one page appear again on a later page (e.g. on pages ${s.pages.slice(0, 2).join(' and ')}), in both a numbered walk and a Link-header walk (${status}). Page boundaries are not stable; de-duplicate client-side or page by a cursor.`, [...A, ...B]));
    } else {
      log.info('scenario', `${endpoint}: duplicates seen in one walk only (numbered ${dA.count}, link ${dB?.count ?? 'n/a'}); not claimed`);
    }
  }

  // I2 Link agreement, or no Link at all.
  const firstLink = A[0].link;
  if (secondHasItems) {
    if (!firstLink.next) {
      out.push(claim('pagination_link', `Responses carry no Link header with rel="next" even though more pages exist (page 2 of ${sizeText} is non-empty): pagination must be driven by counting "${pageParam}" (${status}).`, [A[0], A[1]]));
    } else if (B.length >= 1) {
      const compared = Math.min(A.length - 1, B.length);
      const mismatches: number[] = [];
      for (let i = 0; i < compared; i++) if (A[i + 1].ids.join('\n') !== B[i].ids.join('\n')) mismatches.push(i + 2);
      if (mismatches.length === 0) out.push(claim('pagination_link', `The Link header's rel="next" chain visits the same pages as counting "${pageParam}" up: pages 2..${compared + 1} by Link returned the identical id sequence (${status}). Either method is safe; the Link chain also carries the real page size and any cursor.`, [...A.slice(0, compared + 1), ...B.slice(0, compared)]));
      else out.push(claim('pagination_link', `Following the Link header's rel="next" does NOT return the same items as counting "${pageParam}" up: page(s) ${mismatches.join(', ')} differ between the two methods (${status}). Pick one method and keep it for the whole walk.`, [...A.slice(0, compared + 1), ...B.slice(0, compared)]));
    }
  }

  // I3 stability of a page read twice.
  if (w.again && w.again.status === A[0].status && w.again.isList && secondHasItems) {
    const same = w.again.ids.join('\n') === A[1].ids.join('\n');
    if (same) out.push(claim('pagination_stable', `Page 2 read twice a few seconds apart returned the same ids in the same order (${status}): ordering is stable enough to page through without shifting.`, [A[1], w.again]));
    else out.push(claim('pagination_stable', `Page 2 read twice a few seconds apart did not return the same ids in the same order (${status}): the list is live-ordered, so items can shift between pages while paging. De-duplicate, or page by a cursor or an explicit sort.`, [A[1], w.again]));
  }

  // I4 page size honored on full pages.
  if (sizeParam) {
    // Only a page followed by another page with items is known to be full; the last page may be short.
    const full = A.filter((p, i) => A[i + 1] && A[i + 1].ids.length > 0);
    if (full.length) {
      const sizes = [...new Set(full.map((p) => p.ids.length))];
      if (sizes.length === 1 && sizes[0] === size) out.push(claim('pagination_page_size', `${sizeParam}=${size} is honored: every full page held exactly ${size} items (${status}).`, full));
      else out.push(claim('pagination_page_size', `${sizeParam}=${size} is not what comes back: full pages held ${sizes.sort((a, b) => a - b).join('/')} items (${status}). Read the page size from the response, not from the request.`, full));
    }
  }

  // I5 a clean end, when the budget reached it.
  if (w.endSeen) {
    const last = A[A.length - 1];
    const trailing = last.link.next ? ' but its Link header still offers rel="next"' : !last.link.next && firstLink.next ? ' and the Link header stops offering rel="next"' : '';
    if (last.ids.length === 0 && last.page > 1) out.push(claim('pagination_end', `Past the last page, a page of ${sizeText} returns an empty list${trailing} (${status}), not an error.`, [last]));
    else out.push(claim('pagination_end', `The list ends within the walk: the last page of ${sizeText} is short${trailing} (${status}).`, [last]));
  }
  return out;
}

export interface ScenarioResult {
  trials: Trial[];
  claims: CandidateClaim[];
  requests: number;
}

/** Run the pagination scenario on one endpoint whose baseline response looked like a list. */
export async function runPaginationScenario(db: Db, testRunId: number, ep: EndpointSpec, target: TargetConfig, cfg: PaginationConfig, opts: ExerciseOptions): Promise<ScenarioResult> {
  const label = endpointLabel(ep);
  const params = pagingParams(ep);
  const empty: ScenarioResult = { trials: [], claims: [], requests: 0 };
  if (!params) return empty;
  const base = buildBaseline(ep, target);
  const req = makeRequester(db, testRunId, label, target, opts);
  const byId = new Map<number, Trial>();

  const withPage = (page: number): TrialInput => {
    const q = base.input.query.filter(([k]) => k !== params.page.name && k !== params.size?.name);
    q.push([params.page.name, String(page)]);
    if (params.size) q.push([params.size.name, String(cfg.page_size)]);
    return { ...base.input, headers: { ...base.input.headers }, query: q };
  };

  const fetchPage = async (input: TrialInput, id: string, page: number): Promise<PageObs> => {
    const { trial: inserted, out } = await req.send(input, id, params.page.name);
    byId.set(inserted.id, inserted);
    const list = out.status !== null && out.status < 300 ? listItems(out.body) : null;
    const obs: PageObs = { trialId: inserted.id, status: out.status, page, ids: list ? list.items.map(identityOf) : [], link: parseLinkHeader(out.headers['link']), isList: !!list };
    log.debug('scenario', `${label} ${id} -> ${out.status} ${list ? `${list.items.length} items` : 'not a list'}`);
    return obs;
  };

  // Walk A: by number, stopping at the end of the list.
  const byNumber: PageObs[] = [];
  let endSeen = false;
  for (let p = 1; p <= cfg.pages; p++) {
    const obs = await fetchPage(withPage(p), `scenario:pagination:page:${p}`, p);
    byNumber.push(obs);
    if (!obs.isList) break;
    // The requested size may be clamped (GitHub caps per_page at 100; the mock at 3), so "fewer than
    // requested" is not the end. The end is: an empty page, a page shorter than the first page, or
    // a missing rel="next" on an API that offered one on page 1.
    const effective = byNumber[0].ids.length;
    const linkEnded = !!byNumber[0].link.next && !obs.link.next;
    if (obs.ids.length === 0 || obs.ids.length < effective || (p > 1 && linkEnded) || (p === 1 && effective > 0 && !obs.link.next && Object.keys(obs.link).length > 0)) {
      endSeen = true;
      break;
    }
  }
  if (!byNumber[0]?.isList) return { trials: req.trials, claims: [], requests: req.count };

  // Walk B: by Link, as many pages as walk A reached beyond the first.
  const byLink: PageObs[] = [];
  // The Link header is API-supplied data. A rel="next" that leaves the endpoint's origin (another
  // host, scheme or port) is never followed: the request would carry the target's credentials there.
  const origin = new URL(base.input.url).origin;
  let next = byNumber[0].link.next;
  for (let i = 1; i < byNumber.length && next; i++) {
    let input: TrialInput;
    try {
      if (new URL(next).origin !== origin) {
        log.warn('scenario', `${label}: Link rel="next" points off-origin (${new URL(next).origin}); not followed`);
        break;
      }
      input = inputFromUrl(next, base.input);
    } catch {
      break;
    }
    const obs = await fetchPage(input, `scenario:pagination:link:${i + 1}`, i + 1);
    byLink.push(obs);
    if (!obs.isList) break;
    next = obs.link.next;
  }

  // Re-read page 2 for stability.
  let again: PageObs | null = null;
  let againAfterMs = 0;
  if (byNumber.length >= 2 && byNumber[1].isList) {
    const t0 = byId.get(byNumber[1].trialId)?.createdAt?.getTime() ?? Date.now();
    again = await fetchPage(withPage(2), 'scenario:pagination:page:2:again', 2);
    againAfterMs = Math.max(0, (byId.get(again.trialId)?.createdAt?.getTime() ?? Date.now()) - t0);
  }

  const claims = paginationClaims(label, params.page.name, params.size?.name ?? null, cfg.page_size, { byNumber, byLink, again, againAfterMs, endSeen }, byId);
  log.info('scenario', `${label}: pagination scenario made ${req.count} request(s), ${claims.length} claim(s)`);
  return { trials: req.trials, claims, requests: req.count };
}
