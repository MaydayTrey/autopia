/**
 * RESPONSE-SHAPE RULES (no LLM): what a SUCCESSFUL response looks like and
 * means. Request validation tells an agent what the API refuses; these tell
 * it what it gets back, which is the next thing it asks:
 *
 *   - content type of success responses
 *   - timestamp format and timezone designator (Z / offset / none / epoch)
 *   - null-valued fields vs omitted fields
 *   - pagination fields present at the top level
 *   - rate-limit and caching headers the API exposes
 *
 * Evidence: the baseline trial, plus optional_present trials for timestamps
 * (a bare baseline often has no time series; adding `hourly` does).
 * Stored bodies are truncated (first 5 array elements, 200-char strings),
 * which is enough to classify formats.
 */
import type { Trial } from '../../db/schema.js';
import { ruleClaimKey, type CandidateClaim } from '../claims.js';
import { endpointLabel, type EndpointSpec } from '../spec.js';

type Body = unknown;
interface Resp {
  headers?: Record<string, string>;
  body?: Body;
  bodyKind?: string;
}

const ok = (t: Trial) => t.statusCode !== null && t.statusCode >= 200 && t.statusCode < 300 && t.errorText !== 'rate_limited';

function claim(rule: string, endpoint: string, statement: string, evidence: Trial[], confidence = 0.8): CandidateClaim {
  return {
    claim_key: ruleClaimKey(`shape_${rule}`, endpoint, null),
    statement,
    endpoint,
    kind: 'response_shape',
    param: null,
    verdict: 'observes',
    source: 'rules',
    confidence,
    evidence_trial_ids: evidence.map((t) => t.id),
    expectations: evidence.map((t) => ({ trial_id: t.id, status: t.statusCode })),
    diverges_from_spec: false,
    spec_says: null,
  };
}

export function shapeRules(trials: Trial[], endpoints: EndpointSpec[]): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  for (const ep of endpoints) {
    const label = endpointLabel(ep);
    const mine = trials.filter((t) => t.endpoint === label && ok(t));
    const baseline = mine.find((t) => t.mutationId === 'baseline');
    if (!baseline) continue;
    const resp = baseline.response as Resp;
    const headers = lower(resp.headers ?? {});

    // content type
    const ct = headers['content-type'];
    if (ct) out.push(claim('content_type', label, `Successful responses have content-type "${ct}".`, [baseline], 0.9));

    // rate-limit + cache headers
    const rl = Object.entries(headers).filter(([k]) => /ratelimit|rate-limit|used-weight/.test(k));
    if (rl.length) {
      const stable = rl.filter(([k]) => /limit$|policy$|weight/.test(k) && !/remaining|reset|used$/.test(k)).map(([k, v]) => `${k}=${v}`);
      const names = rl.map(([k]) => k).join(', ');
      out.push(claim('rate_limit_headers', label, `Responses expose rate-limit headers (${names})${stable.length ? `; e.g. ${stable.join(', ')}` : ''}. Read them to pace requests.`, [baseline], 0.9));
    } else {
      out.push(claim('rate_limit_headers', label, 'Responses expose no rate-limit headers; limits are not discoverable from responses, so pace requests conservatively.', [baseline], 0.7));
    }
    if (headers['cache-control']) out.push(claim('cache_control', label, `Responses set Cache-Control "${headers['cache-control']}"${headers['etag'] ? ' and an ETag' : ''}.`, [baseline], 0.8));

    if (resp.bodyKind !== 'json' || resp.body === null || resp.body === undefined) continue;

    // pagination fields (top level)
    if (resp.body && typeof resp.body === 'object' && !Array.isArray(resp.body)) {
      const keys = Object.keys(resp.body as object);
      const pg = keys.filter((k) => /^(total|totalResults|total_count|count|numFound|next|previous|prev|page|pages|per_page|page_size|offset|limit|cursor|next_cursor|pagination|has_more|hasMore|start|links|meta)$/i.test(k));
      if (pg.length) out.push(claim('pagination_fields', label, `The baseline response carries pagination/metadata fields at the top level: ${pg.join(', ')}.`, [baseline], 0.8));
      else out.push(claim('pagination_fields', label, `The baseline response has no top-level pagination fields (keys: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}).`, [baseline], 0.6));
    }

    // nulls
    const nulls = collectNullPaths(resp.body, '', 0, []);
    if (nulls.length) out.push(claim('nulls', label, `The baseline response includes ${nulls.length >= 5 ? 'at least ' : ''}${nulls.length} null-valued field(s) rather than omitting them (e.g. ${nulls.slice(0, 4).join(', ')}).`, [baseline], 0.8));
    else out.push(claim('nulls', label, 'The baseline response contains no null-valued fields; absent data, if any, is represented by omitted keys or empty values.', [baseline], 0.6));

    // timestamps: look across baseline + optional_present successes until something is found
    const stamps = new Map<string, { example: string; count: number; trial: Trial }>();
    for (const t of [baseline, ...mine.filter((x) => x.mutationType === 'optional_present')]) {
      for (const s of collectTimestamps((t.response as Resp).body, '', 0, [])) {
        const cur = stamps.get(s.kind);
        if (cur) cur.count++;
        else stamps.set(s.kind, { example: s.example, count: 1, trial: t });
      }
      if (stamps.size) break;
    }
    if (stamps.size) {
      const parts = [...stamps.entries()].map(([k, v]) => `${describeStamp(k)} (e.g. ${v.example})`);
      const formats = parts.length === 1 ? parts[0] : `${parts.length} formats: ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
      const ev = [...new Set([...stamps.values()].map((v) => v.trial))];
      const tz = stamps.has('iso_utc') ? ' Times are UTC.' : stamps.has('iso_offset') ? ' Times carry an explicit UTC offset.' : stamps.has('iso_naive') ? ' Times carry NO timezone designator; the zone is whatever the request or server default implies.' : stamps.has('epoch_s') || stamps.has('epoch_ms') ? ' Epoch values are UTC by definition.' : '';
      out.push(claim('timestamps', label, parts.length === 1 ? `Timestamps in successful responses are ${formats}.${tz}` : `Timestamps in successful responses use ${formats}; check which field you read.${tz}`, ev, 0.85));
    }
  }
  return out;
}

function lower(h: Record<string, string>): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v;
  return o;
}

function collectNullPaths(v: Body, path: string, depth: number, acc: string[]): string[] {
  if (depth > 5 || acc.length >= 5) return acc;
  if (Array.isArray(v)) {
    v.slice(0, 3).forEach((x, i) => collectNullPaths(x, `${path}[${i}]`, depth + 1, acc));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as object)) {
      const p = path ? `${path}.${k}` : k;
      if (x === null) acc.push(p);
      else collectNullPaths(x, p, depth + 1, acc);
      if (acc.length >= 5) break;
    }
  }
  return acc;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;
const ISO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?[+-]\d{2}:?\d{2}$/;
const ISO_NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_KEY = /time|date|_at$|^at$|timestamp|^ts$|created|updated|modified|expires|issued|effective|ends|start|end/i;

function collectTimestamps(v: Body, key: string, depth: number, acc: { kind: string; example: string }[]): { kind: string; example: string }[] {
  if (depth > 6 || acc.length >= 50) return acc;
  if (typeof v === 'string') {
    if (ISO_UTC.test(v)) acc.push({ kind: 'iso_utc', example: v });
    else if (ISO_OFFSET.test(v)) acc.push({ kind: 'iso_offset', example: v });
    else if (ISO_NAIVE.test(v)) acc.push({ kind: 'iso_naive', example: v });
    else if (DATE_ONLY.test(v) && TIME_KEY.test(key)) acc.push({ kind: 'date_only', example: v });
  } else if (typeof v === 'number' && Number.isInteger(v) && TIME_KEY.test(key)) {
    if (v >= 1e9 && v < 2e9) acc.push({ kind: 'epoch_s', example: String(v) });
    else if (v >= 1e12 && v < 2e12) acc.push({ kind: 'epoch_ms', example: String(v) });
  } else if (Array.isArray(v)) {
    v.slice(0, 3).forEach((x) => collectTimestamps(x, key, depth + 1, acc));
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as object)) collectTimestamps(x, k, depth + 1, acc);
  }
  return acc;
}

function describeStamp(kind: string): string {
  return { iso_utc: 'ISO 8601 with a Z suffix', iso_offset: 'ISO 8601 with a UTC offset', iso_naive: 'ISO 8601 without a timezone designator', date_only: 'calendar dates (YYYY-MM-DD)', epoch_s: 'Unix epoch seconds', epoch_ms: 'Unix epoch milliseconds' }[kind] ?? kind;
}
