/**
 * Executes one TRIAL input against the live API. No LLM, no interpretation.
 *
 * Determinism: TrialInput is a plain, fully pinned description of a request
 * (method, url, ordered query pairs, headers). hashInput() over it gives the
 * input_hash stored on every trial, so re-runs are comparable.
 *
 * Politeness: timeouts, bounded retries with backoff on 429/503, and a UA
 * header that says what we are. Concurrency/throttle live in exercise.ts.
 */
import { signatureOf, type BodyKind, type ResponseSignature } from './signature.js';
import { canonicalJson, sha256 } from './spec.js';
import { log } from './log.js';

export interface TrialInput {
  method: 'GET' | 'HEAD';
  url: string; // server + path, no query string
  query: [string, string][]; // ordered pairs; duplicates allowed on purpose
  headers: Record<string, string>;
}

export interface TrialOutcome {
  status: number | null;
  headers: Record<string, string>;
  bodyKind: BodyKind;
  body: unknown; // full parsed JSON or text; truncate before storing
  transportError: string | null;
  latencyMs: number;
  rateLimited: boolean; // a 429 was seen at any point
  signature: ResponseSignature;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ExecuteOptions {
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export const USER_AGENT = 'autopia/0.1 (read-only API behavior research; contact via repo)';

export function buildUrl(input: TrialInput): string {
  if (input.query.length === 0) return input.url;
  const qs = input.query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  return `${input.url}?${qs}`;
}

export function hashInput(input: TrialInput): string {
  return sha256(canonicalJson({ m: input.method, u: input.url, q: input.query, h: input.headers }));
}

const KEEP_HEADERS = ['content-type', 'content-length', 'cache-control', 'retry-after', 'allow', 'server'];

export async function execute(input: TrialInput, opts: ExecuteOptions = {}): Promise<TrialOutcome> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 3;
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const url = buildUrl(input);
  let rateLimited = false;

  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: input.method,
        headers: { 'user-agent': USER_AGENT, accept: 'application/json, */*;q=0.5', ...input.headers },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (e) {
      const latencyMs = Math.round(performance.now() - started);
      const err = e as Error;
      const transportError = err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : `fetch: ${err.message}`;
      if (attempt < retries && transportError === 'timeout') {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      const body = null;
      return {
        status: null,
        headers: {},
        bodyKind: 'none',
        body,
        transportError,
        latencyMs,
        rateLimited,
        signature: signatureOf({ status: null, bodyKind: 'none', body, transportError }),
      };
    }
    const latencyMs = Math.round(performance.now() - started);
    const headers: Record<string, string> = {};
    for (const k of KEEP_HEADERS) {
      const v = res.headers.get(k);
      if (v !== null) headers[k] = v;
    }
    if (res.status === 429) rateLimited = true;
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 10_000) : 1000 * 2 ** attempt;
      log.warn('http', `got ${res.status}, backing off ${wait}ms`, { url });
      await res.text().catch(() => undefined);
      await sleep(wait);
      continue;
    }

    const text = input.method === 'HEAD' ? '' : await res.text();
    const { bodyKind, body } = parseBody(text, headers['content-type'] ?? '');
    return {
      status: res.status,
      headers,
      bodyKind,
      body,
      transportError: null,
      latencyMs,
      rateLimited,
      signature: signatureOf({ status: res.status, bodyKind, body }),
    };
  }
}

export function parseBody(text: string, contentType: string): { bodyKind: BodyKind; body: unknown } {
  if (text === '') return { bodyKind: 'empty', body: null };
  const looksJson = /json/i.test(contentType) || /^\s*[\[{]/.test(text);
  if (looksJson) {
    try {
      return { bodyKind: 'json', body: JSON.parse(text) };
    } catch {
      /* fall through to text */
    }
  }
  return { bodyKind: 'text', body: text };
}

/** Shrink a body for storage: short strings, short arrays, limited depth. */
export function truncateBody(v: unknown, depth = 0): unknown {
  if (depth > 5) return '…';
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + `…(+${v.length - 200})` : v;
  if (Array.isArray(v)) {
    const head = v.slice(0, 5).map((x) => truncateBody(x, depth + 1));
    return v.length > 5 ? [...head, `…(+${v.length - 5} more)`] : head;
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as object).slice(0, 60)) out[k] = truncateBody(val, depth + 1);
    return out;
  }
  return v;
}
