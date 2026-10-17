/**
 * A tiny fake REST API with PLANTED quirks, so the whole pipeline can be
 * tested offline and deterministically. Two behavior profiles ("v1", "v2")
 * let the integration tests exercise version DIFFs.
 *
 * Planted divergences in v1 (spec says X, server does Y):
 *   - q is declared required            -> server accepts its absence (200)
 *   - limit is declared integer         -> "abc" is silently accepted (200)
 *   - limit has maximum 100             -> 101 is accepted (200)
 *   - sort has enum [asc, desc]         -> enforced (400)          [agrees]
 *   - unknown query params              -> ignored (200)
 *   - api_key                           -> any value accepted (not enforced)
 *   - page = 0                          -> 400
 *   - kind (enum odd|even)              -> honored (items carry kind); bad value 400
 *   - tag                               -> documented, silently IGNORED (items carry tag "none")
 *   - trailing slash                    -> 404 text
 *   - errors                            -> 400 {"error":{"code","message"}}
 * v2 changes: q enforced (400), limit "abc" rejected (400), limit 101 rejected
 * (400), unknown params rejected (400). Everything else identical.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type Profile = 'v1' | 'v2';

export interface MockApi {
  url: string;
  specPath: string;
  /** The same spec served over HTTP (for request-target tests). */
  specUrl: string;
  profile: Profile;
  requests: { method: string; url: string }[];
  close: () => Promise<void>;
}

function spec(serverUrl: string, version: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Mock Items API', version },
    servers: [{ url: serverUrl }],
    paths: {
      '/v1/items': {
        get: {
          operationId: 'listItems',
          parameters: [
            { name: 'q', in: 'query', required: true, schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
            { name: 'page', in: 'query', schema: { type: 'integer' } },
            { name: 'sort', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
            { name: 'kind', in: 'query', schema: { type: 'string', enum: ['odd', 'even'] } },
            { name: 'tag', in: 'query', schema: { type: 'string' } },
            { name: 'api_key', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': { description: 'ok' } },
        },
      },
      '/v1/items/{id}': {
        get: {
          operationId: 'getItem',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
          responses: { '200': { description: 'ok' } },
        },
      },
    },
  };
}

const KNOWN = new Set(['q', 'limit', 'page', 'sort', 'kind', 'tag', 'api_key']);

function handle(profile: Profile, req: http.IncomingMessage, res: http.ServerResponse, specJson: () => string, quirks: MockQuirks = {}, state: MockState = { counted: 0 }) {
  const u = new URL(req.url ?? '/', 'http://x');
  if (u.pathname === '/openapi.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(specJson());
    return;
  }
  const err = (code: string, message: string, status = 400) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code, message } }));
  };
  // Every successful response carries an ETag (hash of the body), a fixed Last-Modified, and a
  // GitHub-style rate-limit family (limit 1000, fixed window, epoch-seconds reset). A matching
  // If-None-Match / If-Modified-Since yields 304; a 304 is free unless the cost_304 quirk is set.
  const LAST_MODIFIED = 'Wed, 01 Oct 2026 00:00:00 GMT';
  const rateHeaders = () => ({ 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': String(1000 - state.counted), 'x-ratelimit-reset': '1800000000', 'x-ratelimit-used': String(state.counted) });
  const ok = (body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    const etag = `"${createHash('sha256').update(text).digest('hex').slice(0, 16)}"`;
    const cond = !quirks.no_etag && (req.headers['if-none-match'] === etag || req.headers['if-modified-since'] === LAST_MODIFIED);
    const validators = quirks.no_etag ? {} : { etag, 'last-modified': LAST_MODIFIED };
    if (cond) {
      if (quirks.cost_304) state.counted++;
      res.writeHead(304, { ...validators, ...rateHeaders(), ...headers });
      res.end();
      return;
    }
    state.counted++;
    res.writeHead(200, { 'content-type': 'application/json', ...validators, ...rateHeaders(), ...headers });
    res.end(req.method === 'HEAD' ? undefined : text);
  };

  if (u.pathname === '/v1/items') {
    const q = u.searchParams.getAll('q');
    const limitRaw = u.searchParams.get('limit');
    const page = u.searchParams.get('page');
    const sort = u.searchParams.get('sort');
    const v2 = profile === 'v2';

    if (v2) for (const k of u.searchParams.keys()) if (!KNOWN.has(k)) return err('unknown_param', `unknown parameter ${k}`);
    if (v2 && q.length === 0) return err('missing_q', 'q is required');
    if (q.includes('null')) return err('invalid_q', 'q may not be null');
    let limit = 10;
    if (limitRaw !== null && limitRaw !== '') {
      const n = Number(limitRaw);
      if (!Number.isInteger(n)) {
        if (v2) return err('invalid_limit', 'limit must be an integer');
        // v1: silently falls back to default
      } else {
        if (n < 1) return err('invalid_limit', 'limit must be >= 1');
        if (v2 && n > 100) return err('invalid_limit', 'limit must be <= 100');
        limit = n;
      }
    }
    if (page !== null && page !== '' && !(Number(page) >= 1)) return err('invalid_page', 'page must be >= 1');
    if (sort !== null && sort !== '' && sort !== 'asc' && sort !== 'desc') return err('invalid_sort', 'sort must be asc or desc');
    const kind = u.searchParams.get('kind');
    if (kind !== null && kind !== '' && kind !== 'odd' && kind !== 'even') return err('invalid_kind', 'kind must be odd or even');
    // A 7-item dataset paged by `page`; the page size is min(limit, 3) (a planted clamp). A Link
    // header offers rel="next" while more remain. With the page_overlap quirk every page after the
    // first starts one item early, so consecutive pages share an item (a real-world ordering bug).
    const ALL = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, name: `item ${i + 1}${quirks.stale_list ? ' (stale)' : ''}`, q: q[0] ?? null, kind: (i + 1) % 2 ? 'odd' : 'even', tag: 'none' }));
    const DATASET = kind ? ALL.filter((it) => it.kind === kind) : ALL; // `tag` is deliberately ignored
    const size = Math.min(limit, 3);
    const pageNo = page ? Math.max(1, Math.floor(Number(page)) || 1) : 1;
    const start = quirks.page_overlap ? (pageNo - 1) * Math.max(1, size - 1) : (pageNo - 1) * size;
    const items = DATASET.slice(start, start + size);
    const headers: Record<string, string> = {};
    if (start + size < DATASET.length) {
      const nextUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      nextUrl.searchParams.set('page', String(pageNo + 1));
      headers.link = `<${nextUrl.toString()}>; rel="next"`;
    }
    return ok({ items, total: DATASET.length, page: pageNo }, headers);
  }

  const m = u.pathname.match(/^\/v1\/items\/([^/]+)$/);
  if (m) {
    const id = Number(m[1]);
    if (!Number.isInteger(id)) return err('invalid_id', 'id must be an integer');
    if (id < 1) return err('not_found', 'no such item', 404);
    // Detail: adds `description`, omits the list's `q` and `tag`.
    return ok({ id, name: `item ${id}`, kind: id % 2 ? 'odd' : 'even', description: `details for item ${id}` });
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

/** Planted scenario quirks: page_overlap makes every page after the first start one item early (the last item repeats); cost_304 makes conditional 304s count against the rate limit; no_etag drops ETag and Last-Modified. */
export interface MockQuirks {
  page_overlap?: boolean;
  cost_304?: boolean;
  no_etag?: boolean;
  /** List items carry a stale name (detail: "item N", list: "item N (stale)"). */
  stale_list?: boolean;
}

/** Per-server state: the rate-limit counter. */
interface MockState {
  counted: number;
}

export async function startMockApi(profile: Profile, quirks: MockQuirks = {}): Promise<MockApi> {
  const requests: MockApi['requests'] = [];
  let specText = '';
  const state: MockState = { counted: 0 };
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    handle(profile, req, res, () => specText, quirks, state);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock api: no address');
  const url = `http://127.0.0.1:${addr.port}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-mock-'));
  const specPath = path.join(dir, `spec-${profile}.json`);
  specText = JSON.stringify(spec(url, profile === 'v1' ? '1.0' : '2.0'), null, 2);
  await writeFile(specPath, specText);
  return {
    url,
    specPath,
    specUrl: url + '/openapi.json',
    profile,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

// Manual use: npx tsx tests/mock-api/server.ts v1
const isMain = process.argv[1] && /mock-api[\\/]server\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  const p = (process.argv[2] as Profile) ?? 'v1';
  startMockApi(p).then((m) => process.stdout.write(`mock api ${p} at ${m.url}\nspec: ${m.specPath}\n`));
}
