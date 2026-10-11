/**
 * A response SIGNATURE is the normalized "shape" of an HTTP response that we
 * expect to be stable across re-runs of the same pinned input, even when the
 * underlying data changes (weather, prices, timestamps).
 *
 * Reproduction (VERIFY stage) compares signatures, never raw bytes.
 *
 *   status        HTTP status (null if the request never got a response)
 *   bodyKind      json | text | empty | none
 *   shape         recursive type-shape of a JSON body (keys sorted, arrays
 *                 described by their first element) to a limited depth
 *   errorMessage  the human error string if the body carries one
 *   transportError  e.g. "timeout" when no HTTP response arrived
 */
import { canonicalJson } from './spec.js';

export type BodyKind = 'json' | 'text' | 'empty' | 'none';

export interface ResponseSignature {
  status: number | null;
  bodyKind: BodyKind;
  shape: unknown;
  errorMessage: string | null;
  transportError: string | null;
}

const MAX_DEPTH = 4;

export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? ['array', 'empty'] : ['array', shapeOf(v[0], depth + 1)];
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1);
    return out;
  }
  return typeof v; // 'string' | 'number' | 'boolean'
}

const ERROR_KEYS = ['reason', 'message', 'error', 'detail', 'error_description', 'msg', 'title'];

/** Pull a human-readable error message out of common API error bodies. */
export function extractErrorMessage(body: unknown): string | null {
  if (typeof body === 'string') return body.length <= 300 && body.trim() ? body.trim() : null;
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  for (const k of ERROR_KEYS) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const inner = extractErrorMessage(v);
      if (inner) return inner;
    }
  }
  if (Array.isArray(o.errors) && o.errors.length) return extractErrorMessage(o.errors[0]);
  return null;
}

export function signatureOf(resp: {
  status: number | null;
  bodyKind: BodyKind;
  body: unknown;
  transportError?: string | null;
}): ResponseSignature {
  const isError = resp.status === null || resp.status >= 400;
  return {
    status: resp.status,
    bodyKind: resp.bodyKind,
    shape: resp.bodyKind === 'json' ? shapeOf(resp.body) : resp.bodyKind,
    // Only error bodies get their message compared; success bodies vary with live data.
    errorMessage: isError ? extractErrorMessage(resp.body) : null,
    transportError: resp.transportError ?? null,
  };
}

export function signaturesEqual(a: ResponseSignature, b: ResponseSignature): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Short human description, used in claim statements and the LLM summary. */
export function describeSignature(s: ResponseSignature): string {
  if (s.transportError) return `transport error (${s.transportError})`;
  const base = `HTTP ${s.status}`;
  if (s.errorMessage) return `${base} "${s.errorMessage}"`;
  if (s.bodyKind === 'json') return `${base} JSON`;
  return `${base} ${s.bodyKind}`;
}
