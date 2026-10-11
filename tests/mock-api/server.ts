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
 *   - trailing slash                    -> 404 text
 *   - errors                            -> 400 {"error":{"code","message"}}
 * v2 changes: q enforced (400), limit "abc" rejected (400), limit 101 rejected
 * (400), unknown params rejected (400). Everything else identical.
 */
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

const KNOWN = new Set(['q', 'limit', 'page', 'sort', 'api_key']);

function handle(profile: Profile, req: http.IncomingMessage, res: http.ServerResponse, specJson: () => string) {
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
  const ok = (body: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
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
    const items = Array.from({ length: Math.min(limit, 3) }, (_, i) => ({ id: i + 1, name: `item ${i + 1}`, q: q[0] ?? null }));
    return ok({ items, total: items.length, page: page ? Number(page) : 1 });
  }

  const m = u.pathname.match(/^\/v1\/items\/([^/]+)$/);
  if (m) {
    const id = Number(m[1]);
    if (!Number.isInteger(id)) return err('invalid_id', 'id must be an integer');
    if (id < 1) return err('not_found', 'no such item', 404);
    return ok({ id, name: `item ${id}` });
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

export async function startMockApi(profile: Profile): Promise<MockApi> {
  const requests: MockApi['requests'] = [];
  let specText = '';
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? '', url: req.url ?? '' });
    handle(profile, req, res, () => specText);
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
