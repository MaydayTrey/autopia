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
 *
 * v1.2: PATH parameters get the same per-parameter probes as query parameters
 * (wrong type, enum, null, empty segment, boundaries, long string), and auth
 * probes target the header/query name the spec's security scheme declares
 * (bad value AND missing), instead of a generic Authorization header.
 */
import type { AuthScheme, EndpointSpec, ParamSpec } from '../spec.js';
import { sha256 } from '../spec.js';
import type { TrialInput } from '../http.js';
import type { TargetConfig } from '../target.js';

export const BATTERY_VERSION = '1.2.0';

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
  'boundary_far_above_max',
  'boundary_long_string',
  'duplicate_param',
  'extra_field',
  'bad_auth',
  'no_auth',
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
const INVALID_CREDENTIAL = 'invalid-key-autopia';

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

/** Substitute {name} placeholders. Values are URL-encoded; an empty value yields an empty segment. */
export function renderPath(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (m, name: string) => (name in values ? encodeURIComponent(values[name]) : m));
}

export interface BaselineRequest {
  input: TrialInput;
  queryParams: ParamSpec[];
  pathParams: ParamSpec[];
  required: ParamSpec[]; // required QUERY params
  optional: ParamSpec[]; // optional QUERY params
  overrides: Record<string, string>; // all known-good values (required + optional)
  pathTemplate: string;
  pathValues: Record<string, string>;
}

/** Build the minimal valid request: required params only, with target-supplied values. */
export function buildBaseline(ep: EndpointSpec, target: TargetConfig): BaselineRequest {
  const base = target.baseline?.[ep.path] ?? {};
  const opt = target.optional_values?.[ep.path] ?? {};
  const overrides = { ...opt, ...base };

  const headers: Record<string, string> = { ...(target.headers ?? {}) };
  const query: [string, string][] = [];
  const queryParams: ParamSpec[] = [];
  const pathParams: ParamSpec[] = [];
  const pathValues: Record<string, string> = {};

  for (const p of ep.params) {
    if (p.in === 'path') {
      pathParams.push(p);
      pathValues[p.name] = valueFor(p, overrides[p.name]);
    } else if (p.in === 'header') {
      if (p.required || overrides[p.name] !== undefined) headers[p.name] = valueFor(p, overrides[p.name]);
    } else {
      queryParams.push(p);
      if (p.required) query.push([p.name, valueFor(p, overrides[p.name])]);
    }
  }
  const input: TrialInput = { method: 'GET', url: ep.server + renderPath(ep.path, pathValues), query, headers };
  if (pathParams.length) input.pathParams = { ...pathValues };
  return {
    input,
    queryParams,
    pathParams,
    required: queryParams.filter((p) => p.required),
    optional: queryParams.filter((p) => !p.required),
    overrides,
    pathTemplate: ep.path,
    pathValues,
  };
}

// --- helpers (pure) ---------------------------------------------------------
const without = (q: [string, string][], name: string): [string, string][] => q.filter(([k]) => k !== name);
const set = (q: [string, string][], name: string, value: string): [string, string][] => [...without(q, name), [name, value]];
const withInput = (base: TrialInput, patch: Partial<TrialInput>): TrialInput => ({ ...base, headers: { ...base.headers }, query: [...base.query], ...(base.pathParams ? { pathParams: { ...base.pathParams } } : {}), ...patch });

/** Probe values for one parameter, shared by query and path parameters. */
function paramProbes(p: ParamSpec): { type: MutationType; description: string; value: string }[] {
  const out: { type: MutationType; description: string; value: string }[] = [];
  const numeric = p.type === 'integer' || p.type === 'number' || (p.type === 'array' && (p.itemType === 'integer' || p.itemType === 'number'));
  if (numeric) out.push({ type: 'wrong_type', description: `Send a non-numeric string for ${p.type} parameter ${p.name}`, value: 'abc' });
  if (p.type === 'boolean') out.push({ type: 'wrong_type', description: `Send a non-boolean string for boolean parameter ${p.name}`, value: 'maybe' });
  if (p.enum && p.enum.length) out.push({ type: 'enum_invalid', description: `Send a value outside the documented enum for ${p.name}`, value: 'not_a_documented_value' });
  out.push({ type: 'null_value', description: `Send the literal string "null" for ${p.name}`, value: 'null' });
  out.push({ type: 'empty_value', description: `Send an empty value for ${p.name}`, value: '' });
  if (p.type === 'integer' || p.type === 'number') {
    out.push({ type: 'boundary_zero', description: `Send 0 for ${p.name}`, value: '0' });
    out.push({ type: 'boundary_negative', description: `Send -1 for ${p.name}`, value: '-1' });
    out.push({ type: 'boundary_max_int', description: `Send 2147483648 (above int32) for ${p.name}`, value: '2147483648' });
    if (p.minimum !== undefined) out.push({ type: 'boundary_below_min', description: `Send ${p.minimum - 1}, below documented minimum ${p.minimum}, for ${p.name}`, value: String(p.minimum - 1) });
    if (p.maximum !== undefined) {
      out.push({ type: 'boundary_above_max', description: `Send ${p.maximum + 1}, above documented maximum ${p.maximum}, for ${p.name}`, value: String(p.maximum + 1) });
      const far = p.maximum > 0 ? p.maximum * 10 : p.maximum + 1000;
      out.push({ type: 'boundary_far_above_max', description: `Send ${far}, far above documented maximum ${p.maximum}, for ${p.name}`, value: String(far) });
    }
  }
  if (p.type === 'string' && !p.enum) out.push({ type: 'boundary_long_string', description: `Send a 2048-character string for ${p.name}`, value: LONG_STRING });
  return out;
}

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

  // Per-QUERY-parameter probes. For optional params the comparison base is optional_present:<p>.
  for (const p of b.queryParams) {
    const baseOf = p.required ? 'baseline' : `optional_present:${p.name}`;
    const baseQuery = p.required ? b.input.query : set(b.input.query, p.name, valueFor(p, b.overrides[p.name]));
    for (const probe of paramProbes(p)) add(probe.type, p.name, probe.description, baseOf, withInput(b.input, { query: set(baseQuery, p.name, probe.value) }));

    if (p.required) {
      const v = valueFor(p, b.overrides[p.name]);
      const v2 = /^-?\d+(\.\d+)?$/.test(v) ? String(Number(v) + 1) : v + '2';
      add('duplicate_param', p.name, `Send ${p.name} twice with different values`, 'baseline', withInput(b.input, { query: [...b.input.query, [p.name, v2]] }));
    }

    if (PAGINATION_PARAM.test(p.name)) {
      const pg = (type: MutationType, description: string, value: string) => add(type, p.name, description, baseOf, withInput(b.input, { query: set(baseQuery, p.name, value) }));
      pg('pagination_zero', `Pagination parameter ${p.name} = 0`, '0');
      pg('pagination_huge', `Pagination parameter ${p.name} = 100000`, '100000');
      pg('pagination_beyond', `Pagination parameter ${p.name} = 999999999`, '999999999');
    }
  }

  // Per-PATH-parameter probes: same catalogue, substituted into the path segment.
  for (const p of b.pathParams) {
    for (const probe of paramProbes(p)) {
      const values = { ...b.pathValues, [p.name]: probe.value };
      add(probe.type, p.name, `${probe.description} (path segment)`, 'baseline', withInput(b.input, { url: ep.server + renderPath(b.pathTemplate, values), pathParams: values }));
    }
  }

  // Endpoint-level probes.
  add('extra_field', null, 'Include an unknown query parameter', 'baseline', withInput(b.input, { query: [...b.input.query, ['autopia_unknown_param', '1']] }));

  // Auth probes: one pair per declared apiKey scheme (bad value, missing), else the legacy heuristics.
  const schemes: AuthScheme[] = ep.authSchemes.length
    ? ep.authSchemes
    : b.queryParams.filter((p) => AUTH_PARAM.test(p.name)).map((p) => ({ scheme: p.name, name: p.name, in: 'query' as const }));
  for (const s of schemes) {
    if (s.in === 'query') {
      add('bad_auth', s.name, `Send an invalid value for auth parameter ${s.name}`, 'baseline', withInput(b.input, { query: set(b.input.query, s.name, INVALID_CREDENTIAL) }));
      if (b.input.query.some(([k]) => k === s.name)) add('no_auth', s.name, `Omit auth parameter ${s.name}`, 'baseline', withInput(b.input, { query: without(b.input.query, s.name) }));
    } else {
      const key = s.name.toLowerCase();
      add('bad_auth', s.name, `Send an invalid value in auth header ${s.name}`, 'baseline', withInput(b.input, { headers: { ...b.input.headers, [key]: INVALID_CREDENTIAL } }));
      // '' tells the executor to send NO such header (it also strips its own default User-Agent).
      add('no_auth', s.name, `Omit auth header ${s.name}`, 'baseline', withInput(b.input, { headers: { ...b.input.headers, [key]: '' } }));
    }
  }
  if (schemes.length === 0 && (ep.hasSecurity || Object.keys(b.input.headers).some((h) => /auth|api[-_]?key|token/i.test(h)))) {
    const headers = { ...b.input.headers };
    for (const h of Object.keys(headers)) if (/auth|api[-_]?key|token/i.test(h)) headers[h] = INVALID_CREDENTIAL;
    if (!Object.keys(headers).some((h) => /auth|api[-_]?key|token/i.test(h))) headers['authorization'] = `Bearer ${INVALID_CREDENTIAL}`;
    add('bad_auth', null, 'Send invalid credentials in the auth header', 'baseline', withInput(b.input, { headers }));
  }

  add('wrong_content_type', null, 'Ask for XML via Accept and Content-Type headers', 'baseline', withInput(b.input, { headers: { ...b.input.headers, accept: 'application/xml', 'content-type': 'application/xml' } }));
  if (!b.input.url.endsWith('/')) add('path_trailing_slash', null, 'Request the path with a trailing slash', 'baseline', withInput(b.input, { url: b.input.url + '/' }));
  add('method_head', null, 'HEAD request with the baseline query', 'baseline', withInput(b.input, { method: 'HEAD' }));

  return out;
}
