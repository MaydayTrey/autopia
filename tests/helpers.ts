/** Test helpers: fabricate Trial / Claim rows and a fixture endpoint without a DB. */
import type { Claim, Trial } from '../src/db/schema.js';
import { signatureOf } from '../src/worker/signature.js';
import type { EndpointSpec } from '../src/worker/spec.js';

let nextId = 1;
export function resetIds(start = 1) {
  nextId = start;
}

export const ERR = (code: string, message: string) => ({ error: { code, message } });
export const OK_LIST = { items: [{ id: 1, name: 'a' }], total: 1, page: 1 };

export function fakeTrial(p: {
  mutationId: string;
  status: number | null;
  body?: unknown;
  param?: string | null;
  endpoint?: string;
  query?: [string, string][];
  errorText?: string | null;
  id?: number;
  headers?: Record<string, string>;
  url?: string;
  method?: 'GET' | 'HEAD';
}): Trial {
  const id = p.id ?? nextId++;
  const [type, paramFromId] = p.mutationId.split(':');
  const bodyKind = p.body === undefined ? 'empty' : typeof p.body === 'string' ? 'text' : 'json';
  const body = p.body === undefined ? null : p.body;
  const signature = signatureOf({ status: p.status, bodyKind, body, transportError: p.status === null ? 'timeout' : null });
  return {
    id,
    testRunId: 1,
    endpoint: p.endpoint ?? 'GET /v1/items',
    mutationType: type,
    mutationId: p.mutationId,
    paramName: p.param === undefined ? paramFromId ?? null : p.param,
    input: { method: p.method ?? 'GET', url: p.url ?? 'http://x/v1/items', query: p.query ?? [], headers: p.headers ?? {} },
    inputHash: `hash-${id}`,
    response: { status: p.status, headers: { 'content-type': 'application/json' }, body, bodyKind },
    signature: signature as unknown as object,
    statusCode: p.status,
    errorText: p.errorText === undefined ? (p.status === null ? 'timeout' : signature.errorMessage) : p.errorText,
    latencyMs: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

export function fakeClaim(p: { claimKey: string; verdict?: string; statuses?: (number | null)[]; id?: number; statement?: string; kind?: string; param?: string | null; divergence?: boolean }): Claim {
  const statuses = p.statuses ?? [200];
  return {
    id: p.id ?? nextId++,
    toolVersionId: 1,
    testRunId: 1,
    claimKey: p.claimKey,
    statement: p.statement ?? `statement for ${p.claimKey}`,
    endpoint: 'GET /v1/items',
    kind: p.kind ?? 'other',
    paramName: p.param ?? null,
    verdict: p.verdict ?? 'observes',
    source: 'rules',
    confidence: 0.9,
    divergenceType: p.divergence ? 'spec' : null,
    specSays: null,
    verified: true,
    evidenceTrialIds: statuses.map((_, i) => i + 1),
    expectations: statuses.map((s, i) => ({ trial_id: i + 1, status: s })),
    embedding: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

export const itemsEndpoint: EndpointSpec = {
  method: 'GET',
  path: '/v1/items',
  server: 'http://x',
  operationId: 'listItems',
  hasSecurity: false,
  params: [
    { name: 'q', in: 'query', required: true, type: 'string', explode: true },
    { name: 'limit', in: 'query', required: false, type: 'integer', minimum: 1, maximum: 100, explode: true },
    { name: 'page', in: 'query', required: false, type: 'integer', explode: true },
    { name: 'sort', in: 'query', required: false, type: 'string', enum: ['asc', 'desc'], explode: true },
    { name: 'api_key', in: 'query', required: false, type: 'string', explode: true },
  ],
};
