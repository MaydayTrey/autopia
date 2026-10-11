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

/**
 * Objects that are ELEMENTS of an array are summarized as the opaque 'object'.
 * Array elements are the part of a live feed that changes between calls (which
 * alert is first, which optional keys that record carries), while the
 * top-level structure and any nested objects outside arrays are the API's
 * stable contract. Arrays of primitives and arrays of arrays keep their shape.
 */
export function shapeOf(v: unknown, depth = 0, inArray = false): unknown {
  if (depth > MAX_DEPTH) return '…';
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length === 0 ? ['array', 'empty'] : ['array', shapeOf(v[0], depth + 1, true)];
  if (typeof v === 'object') {
    if (inArray) return 'object';
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = shapeOf((v as Record<string, unknown>)[k], depth + 1, false);
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

/**
 * Two signatures match when status, body kind, error message and transport
 * error are identical and their shapes are COMPATIBLE. Compatibility, not
 * equality, because live data has nullable fields and sometimes-empty arrays:
 * an alert feed whose first item has geometry one minute and null the next is
 * the same API behavior. Rules:
 *   - 'null' is compatible with any shape (nullable field)
 *   - an empty array is compatible with any array
 *   - objects must have the same key set, with each key compatible
 *   - everything else must be identical
 */
export function signaturesEqual(a: ResponseSignature, b: ResponseSignature): boolean {
  return a.status === b.status && a.bodyKind === b.bodyKind && a.errorMessage === b.errorMessage && a.transportError === b.transportError && shapesCompatible(a.shape, b.shape);
}

export function shapesCompatible(a: unknown, b: unknown): boolean {
  if (a === 'null' || b === 'null' || a === '…' || b === '…') return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a[1] === 'empty' || b[1] === 'empty') return true;
    return shapesCompatible(a[1], b[1]);
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => shapesCompatible((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
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
