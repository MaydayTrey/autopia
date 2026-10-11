/**
 * THE BATTERY: the reusable catalogue of generic API edge cases
 * (docs/compendium-spec.txt section 6).
 *
 * Every item is a deterministic transform of a valid BASELINE request. The
 * spec supplies the endpoint + field list, the target file supplies known-good
 * values, the battery supplies the mutations. There is no randomness anywhere,
 * so two runs on the same spec + target produce byte-identical trial inputs.
 *
 * Each Mutation records `baseOf`: the mutation id whose response it should be
 * compared against (the baseline, or optional_present:<param> when the probe
 * is about an optional parameter that the baseline does not include).
 */
import type { EndpointSpec, ParamSpec } from '../spec.js';
import { sha256 } from '../spec.js';
import type { TrialInput } from '../http.js';
import type { TargetConfig } from '../target.js';

export const BATTERY_VERSION = '1.0.0';

export const MUTATION_TYPES = [
  'baseline',
  'required_omitted',
  'required_all_omitted',
  'optional_present',
  'wrong_type',
  'enum_invalid',
  'null_value',
  'empty_value',
  'boundary_zero',
  'boundary_negative',
  'boundary_max_int',
  'boundary_below_min',
  'boundary_above_max',
  'boundary_long_string',
  'duplicate_param',
  'extra_field',
  'bad_auth',
  'pagination_zero',
  'pagination_huge',
  'pagination_beyond',
  'wrong_content_type',
  'path_trailing_slash',
  'method_head',
] as const;
export type MutationType = (typeof MUTATION_TYPES)[number];

export interface Mutation {
  id: string; // "<type>" or "<type>:<param>"
  type: MutationType;
  param: string | null;
  description: string;
  baseOf: string | null; // mutation id to compare against
  input: TrialInput;
}

export function batteryHash(): string {
  return sha256(`${BATTERY_VERSION}:${MUTATION_TYPES.join(',')}`);
}

const AUTH_PARAM = /^(api[-_]?key|apikey|key|token|access[-_]?token|auth)$/i;
const PAGINATION_PARAM = /^(page|limit|per[-_]?page|page[-_]?size|offset|count|page_number)$/i;
const LONG_STRING = 'x'.repeat(2048);

/** Deterministic valid-looking value for a parameter. Override > example > default > enum > type. */
export function valueFor(p: ParamSpec, override?: string): string {
  if (override !== undefined) return override;
  if (p.example !== undefined && p.example !== null) return scalar(p.example, p);
  if (p.default !== undefined && p.default !== null) return scalar(p.default, p);
  if (p.enum && p.enum.length) return p.enum[0];
  return byType(p.type, p);
}

function scalar(v: unknown, p: ParamSpec): string {
  if (Array.isArray(v)) return v.map(String).join(p.explode ? ',' : ',');
  if (typeof v === 'object' && v !== null) return JSON.stringify(v);
  return String(v);
}

function byType(t: ParamSpec['type'], p: ParamSpec): string {
  switch (t) {
    case 'integer':
      return clampToRange(1, p).toString();
    case 'number':
      return clampToRange(1.5, p).toString();
    case 'boolean':
      return 'true';
    case 'array':
      return p.enum?.length ? p.enum[0] : byType(p.itemType ?? 'string', { ...p, enum: undefined });
    case 'object':
      return '{}';
    case 'string':
    default:
      if (p.format === 'date') return '2026-01-15';
      if (p.format === 'date-time') return '2026-01-15T12:00:00Z';
      if (p.format === 'uuid') return '00000000-0000-4000-8000-000000000000';
      if (p.format === 'email') return 'test@example.com';
      if (p.format === 'uri' || p.format === 'url') return 'https://example.com';
      return 'test';
  }
}

function clampToRange(n: number, p: ParamSpec): number {
  if (p.minimum !== undefined && n < p.minimum) return p.minimum;
  if (p.maximum !== undefined && n > p.maximum) return p.maximum;
  return n;
}

export interface BaselineRequest {
  input: TrialInput;
  queryParams: ParamSpec[];
  required: ParamSpec[];
  optional: ParamSpec[];
  overrides: Record<string, string>; // all known-good values (required + optional)
}

/** Build the minimal valid request: required params only, with target-supplied values. */
export function buildBaseline(ep: EndpointSpec, target: TargetConfig): BaselineRequest {
  const base = target.baseline?.[ep.path] ?? {};
  const opt = target.optional_values?.[ep.path] ?? {};
  const overrides = { ...opt, ...base };

  let path = ep.path;
  const headers: Record<string, string> = { ...(target.headers ?? {}) };
  const query: [string, string][] = [];
  const queryParams: ParamSpec[] = [];

  for (const p of ep.params) {
    if (p.in === 'path') {
      path = path.replace(`{${p.name}}`, encodeURIComponent(valueFor(p, overrides[p.name])));
    } else if (p.in === 'header') {
      if (p.required || overrides[p.name] !== undefined) headers[p.name] = valueFor(p, overrides[p.name]);
    } else {
      queryParams.push(p);
      if (p.required) query.push([p.name, valueFor(p, overrides[p.name])]);
    }
  }
  return {
    input: { method: 'GET', url: ep.server + path, query, headers },
    queryParams,
    required: queryParams.filter((p) => p.required),
    optional: queryParams.filter((p) => !p.required),
    overrides,
  };
}

// --- query helpers (pure) ---------------------------------------------------
const without = (q: [string, string][], name: string): [string, string][] => q.filter(([k]) => k !== name);
const set = (q: [string, string][], name: string, value: string): [string, string][] => [...without(q, name), [name, value]];
const withInput = (base: TrialInput, patch: Partial<TrialInput>): TrialInput => ({ ...base, headers: { ...base.headers }, query: [...base.query], ...patch });

/** Generate the full, ordered, deterministic trial plan for one endpoint. */
export function planTrials(ep: EndpointSpec, target: TargetConfig): Mutation[] {
  const b = buildBaseline(ep, target);
  const out: Mutation[] = [];
  const add = (type: MutationType, param: string | null, description: string, baseOf: string | null, input: TrialInput) =>
    out.push({ id: param ? `${type}:${param}` : type, type, param, description, baseOf, input });

  add('baseline', null, 'Valid request with required parameters only', null, b.input);

  for (const p of b.required) {
    add('required_omitted', p.name, `Omit required parameter ${p.name}`, 'baseline', withInput(b.input, { query: without(b.input.query, p.name) }));
  }
  if (b.required.length >= 2) {
    add('required_all_omitted', null, 'Omit every required parameter', 'baseline', withInput(b.input, { query: [] }));
  }
  for (const p of b.optional) {
    add('optional_present', p.name, `Add optional parameter ${p.name} with a valid value`, 'baseline', withInput(b.input, { query: set(b.input.query, p.name, valueFor(p, b.overrides[p.name])) }));
  }

  // Per-parameter probes. For optional params the comparison base is optional_present:<p>.
  for (const p of b.queryParams) {
    const baseOf = p.required ? 'baseline' : `optional_present:${p.name}`;
    const baseQuery = p.required ? b.input.query : set(b.input.query, p.name, valueFor(p, b.overrides[p.name]));
    const probe = (type: MutationType, description: string, value: string) =>
      add(type, p.name, description, baseOf, withInput(b.input, { query: set(baseQuery, p.name, value) }));

    const numeric = p.type === 'integer' || p.type === 'number' || (p.type === 'array' && (p.itemType === 'integer' || p.itemType === 'number'));
    if (numeric) probe('wrong_type', `Send a non-numeric string for ${p.type} parameter ${p.name}`, 'abc');
    if (p.type === 'boolean') probe('wrong_type', `Send a non-boolean string for boolean parameter ${p.name}`, 'maybe');
    if (p.enum && p.enum.length) probe('enum_invalid', `Send a value outside the documented enum for ${p.name}`, 'not_a_documented_value');

    probe('null_value', `Send the literal string "null" for ${p.name}`, 'null');
    probe('empty_value', `Send an empty value for ${p.name}`, '');

    if (p.type === 'integer' || p.type === 'number') {
      probe('boundary_zero', `Send 0 for ${p.name}`, '0');
      probe('boundary_negative', `Send -1 for ${p.name}`, '-1');
      probe('boundary_max_int', `Send 2147483648 (above int32) for ${p.name}`, '2147483648');
      if (p.minimum !== undefined) probe('boundary_below_min', `Send ${p.minimum - 1}, below documented minimum ${p.minimum}, for ${p.name}`, String(p.minimum - 1));
      if (p.maximum !== undefined) probe('boundary_above_max', `Send ${p.maximum + 1}, above documented maximum ${p.maximum}, for ${p.name}`, String(p.maximum + 1));
    }
    if (p.type === 'string' && !p.enum) probe('boundary_long_string', `Send a 2048-character string for ${p.name}`, LONG_STRING);

    if (p.required) {
      const v = valueFor(p, b.overrides[p.name]);
      const v2 = /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v) + 1) : v + '2';
      add('duplicate_param', p.name, `Send ${p.name} twice with different values`, 'baseline', withInput(b.input, { query: [...b.input.query, [p.name, v2]] }));
    }

    if (PAGINATION_PARAM.test(p.name)) {
      probe('pagination_zero', `Pagination parameter ${p.name} = 0`, '0');
      probe('pagination_huge', `Pagination parameter ${p.name} = 100000`, '100000');
      probe('pagination_beyond', `Pagination parameter ${p.name} = 999999999`, '999999999');
    }
  }

  // Endpoint-level probes.
  add('extra_field', null, 'Include an unknown query parameter', 'baseline', withInput(b.input, { query: [...b.input.query, ['autopia_unknown_param', '1']] }));

  const authParam = b.queryParams.find((p) => AUTH_PARAM.test(p.name));
  if (authParam) {
    add('bad_auth', null, `Send an invalid value for auth parameter ${authParam.name}`, 'baseline', withInput(b.input, { query: set(b.input.query, authParam.name, 'invalid-key-autopia') }));
  } else if (ep.hasSecurity || Object.keys(b.input.headers).some((h) => /auth|api[-_]?key|token/i.test(h))) {
    const headers = { ...b.input.headers };
    for (const h of Object.keys(headers)) if (/auth|api[-_]?key|token/i.test(h)) headers[h] = 'invalid-key-autopia';
    if (!Object.keys(headers).some((h) => /auth|api[-_]?key|token/i.test(h))) headers['authorization'] = 'Bearer invalid-key-autopia';
    add('bad_auth', null, 'Send invalid credentials in the auth header', 'baseline', withInput(b.input, { headers }));
  }

  add('wrong_content_type', null, 'Ask for XML via Accept and Content-Type headers', 'baseline', withInput(b.input, { headers: { ...b.input.headers, accept: 'application/xml', 'content-type': 'application/xml' } }));
  if (!b.input.url.endsWith('/')) add('path_trailing_slash', null, 'Request the path with a trailing slash', 'baseline', withInput(b.input, { url: b.input.url + '/' }));
  add('method_head', null, 'HEAD request with the baseline query', 'baseline', withInput(b.input, { method: 'HEAD' }));

  return out;
}
