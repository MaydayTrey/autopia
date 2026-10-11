/**
 * DISCOVER helpers: fetch an OpenAPI 3.x document, validate it parses, extract
 * the read-only (GET) endpoints and their parameters, and fingerprint it.
 *
 * Out of scope (by design): Swagger 2.0, non-GET operations, requestBody,
 * OAuth. If the spec is not OpenAPI 3.x with at least one GET, discover STOPS.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';

export type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown';

export interface ParamSpec {
  name: string;
  in: 'query' | 'path' | 'header';
  required: boolean;
  type: ParamType;
  itemType?: ParamType;
  format?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  example?: unknown;
  default?: unknown;
  explode: boolean;
  description?: string;
}

/** An apiKey-style security scheme that applies to an endpoint: which header or query param carries the credential. */
export interface AuthScheme {
  scheme: string; // name in components.securitySchemes
  name: string; // header or query parameter name, e.g. "User-Agent", "X-Api-Key"
  in: 'header' | 'query';
}

export interface EndpointSpec {
  method: 'GET';
  path: string;
  server: string;
  operationId?: string;
  summary?: string;
  params: ParamSpec[];
  hasSecurity: boolean;
  /** apiKey schemes the spec says apply here (http bearer/oauth are out of v1 scope and not listed). */
  authSchemes: AuthScheme[];
}

export interface ParsedSpec {
  title: string;
  version: string;
  endpoints: EndpointSpec[];
}

/** Endpoint label used everywhere in the DB, e.g. "GET /v1/forecast". */
export function endpointLabel(ep: Pick<EndpointSpec, 'method' | 'path'>): string {
  return `${ep.method} ${ep.path}`;
}

export class SpecError extends Error {}

/** Fetch spec text from http(s), file://, or a local path. */
export async function fetchSpecText(url: string): Promise<string> {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url, { headers: { 'user-agent': 'autopia/0.1' } });
    if (!res.ok) throw new SpecError(`Spec fetch failed: ${res.status} ${res.statusText} for ${url}`);
    return await res.text();
  }
  const p = url.startsWith('file://') ? new URL(url) : url;
  return await readFile(p, 'utf8');
}

export function parseSpecText(text: string): unknown {
  try {
    return YAML.parse(text); // YAML is a superset of JSON, so this handles both
  } catch (e) {
    throw new SpecError(`Spec does not parse as YAML/JSON: ${(e as Error).message}`);
  }
}

/** Stable JSON: object keys sorted recursively, so hashes do not depend on key order. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/**
 * Keep only the given paths plus whatever they reference (transitively) under
 * components, so a 13MB document like GitHub's stores and uploads as a few
 * hundred KB when a target names a handful of endpoints. The spec HASH is
 * always computed on the full document, so any upstream change still makes a
 * new version; trimming only affects what is stored as spec_blob.
 */
export function trimSpec(docIn: unknown, keepPaths: string[]): unknown {
  if (!isObj(docIn) || !isObj(docIn.paths)) return docIn;
  const doc = docIn;
  const allPaths = doc.paths as AnyObj;
  const paths: AnyObj = {};
  for (const p of keepPaths) if (p in allPaths) paths[p] = allPaths[p];
  const components = isObj(doc.components) ? doc.components : {};
  const kept: Record<string, AnyObj> = {};
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isObj(node)) return;
    if (typeof node.$ref === 'string' && node.$ref.startsWith('#/components/')) {
      const [, , group, name] = node.$ref.split('/');
      const key = `${group}/${name}`;
      if (!seen.has(key)) {
        seen.add(key);
        const target = isObj(components[group]) ? (components[group] as AnyObj)[name] : undefined;
        if (target !== undefined) {
          (kept[group] ??= {})[name] = target;
          walk(target);
        }
      }
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(paths);
  const out: AnyObj = { ...doc, paths, components: { ...kept } };
  if (isObj(components.securitySchemes)) (out.components as AnyObj).securitySchemes = components.securitySchemes;
  out['x-autopia-trimmed'] = { kept_paths: keepPaths.length, original_paths: Object.keys(allPaths).length };
  return out;
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashSpec(doc: unknown): string {
  return sha256(canonicalJson(doc));
}

type AnyObj = Record<string, unknown>;
const isObj = (v: unknown): v is AnyObj => !!v && typeof v === 'object' && !Array.isArray(v);

/** Resolve local "#/a/b/c" refs. Remote refs are out of scope. */
function makeResolver(doc: AnyObj) {
  return function resolve<T = AnyObj>(node: unknown, depth = 0): T {
    if (!isObj(node) || typeof node.$ref !== 'string') return node as T;
    if (depth > 20) throw new SpecError('$ref cycle too deep');
    const ref = node.$ref;
    if (!ref.startsWith('#/')) throw new SpecError(`Unsupported non-local $ref: ${ref}`);
    let cur: unknown = doc;
    for (const seg of ref.slice(2).split('/')) {
      const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObj(cur) || !(key in cur)) throw new SpecError(`Unresolvable $ref: ${ref}`);
      cur = cur[key];
    }
    return resolve<T>(cur, depth + 1);
  };
}

function schemaType(schema: AnyObj | undefined): ParamType {
  if (!schema) return 'unknown';
  let t = schema.type;
  if (Array.isArray(t)) t = t.find((x) => x !== 'null') ?? 'unknown'; // OpenAPI 3.1 allows ["string","null"]
  if (typeof t === 'string' && ['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(t))
    return t as ParamType;
  if (schema.enum) return 'string';
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return 'unknown';
}

export interface ExtractOptions {
  /** Base URL used when the spec declares no absolute server; if `overrideServer` is true it replaces the spec's servers. */
  server?: string;
  overrideServer?: boolean;
}

export function extractEndpoints(docIn: unknown, opts: ExtractOptions = {}): ParsedSpec {
  if (!isObj(docIn)) throw new SpecError('Spec root is not an object');
  const doc = docIn;
  const openapi = String(doc.openapi ?? '');
  if (!openapi.startsWith('3.')) {
    throw new SpecError(
      doc.swagger ? 'Swagger 2.0 specs are out of scope for v1; need OpenAPI 3.x' : 'Not an OpenAPI 3.x document (missing "openapi: 3.x")',
    );
  }
  if (!isObj(doc.paths)) throw new SpecError('Spec has no "paths" object');
  const resolve = makeResolver(doc);
  const info = isObj(doc.info) ? doc.info : {};
  const rootServers = Array.isArray(doc.servers) ? doc.servers : [];
  const rootSecurity = Array.isArray(doc.security) && doc.security.length > 0;
  const components = isObj(doc.components) ? doc.components : {};
  const schemes = isObj(components.securitySchemes) ? components.securitySchemes : {};
  /** Turn a security requirement list into the apiKey schemes it names. */
  const authSchemesFor = (requirements: unknown): AuthScheme[] => {
    if (!Array.isArray(requirements)) return [];
    const out: AuthScheme[] = [];
    for (const req of requirements) {
      if (!isObj(req)) continue;
      for (const schemeName of Object.keys(req)) {
        const s = resolve<AnyObj>(schemes[schemeName]);
        if (!isObj(s) || s.type !== 'apiKey' || typeof s.name !== 'string') continue;
        const where = s.in === 'query' ? 'query' : s.in === 'header' ? 'header' : null;
        if (!where) continue;
        if (!out.some((o) => o.scheme === schemeName)) out.push({ scheme: schemeName, name: s.name, in: where });
      }
    }
    return out;
  };

  const endpoints: EndpointSpec[] = [];
  for (const [path, rawItem] of Object.entries(doc.paths)) {
    const item = resolve<AnyObj>(rawItem);
    if (!isObj(item)) continue;
    const op = resolve<AnyObj>(item.get);
    if (!isObj(op)) continue; // v1 scope: GET only
    if (op.requestBody) continue;

    const servers = (Array.isArray(op.servers) && op.servers) || (Array.isArray(item.servers) && item.servers) || rootServers;
    const declared = isObj(servers[0]) ? String(servers[0].url ?? '') : '';
    const serverUrl = opts.server && (opts.overrideServer || !/^https?:\/\//i.test(declared)) ? opts.server : declared;
    if (!/^https?:\/\//i.test(serverUrl)) {
      throw new SpecError(`Endpoint ${path} has no absolute server URL (got "${declared}"); set "server" in the target file`);
    }

    const merged = new Map<string, ParamSpec>();
    for (const list of [item.parameters, op.parameters]) {
      if (!Array.isArray(list)) continue;
      for (const rawP of list) {
        const p = resolve<AnyObj>(rawP);
        if (!isObj(p)) continue;
        const where = String(p.in ?? 'query');
        if (where !== 'query' && where !== 'path' && where !== 'header') continue;
        const schema = resolve<AnyObj | undefined>(p.schema);
        const items = isObj(schema) && isObj(schema.items) ? resolve<AnyObj>(schema.items) : undefined;
        const enumList = (isObj(schema) && Array.isArray(schema.enum) && schema.enum) || (items && Array.isArray(items.enum) && items.enum) || undefined;
        const spec: ParamSpec = {
          name: String(p.name),
          in: where,
          required: where === 'path' ? true : Boolean(p.required),
          type: schemaType(schema),
          itemType: items ? schemaType(items) : undefined,
          format: isObj(schema) && typeof schema.format === 'string' ? schema.format : undefined,
          enum: enumList ? enumList.map(String) : undefined,
          minimum: isObj(schema) && typeof schema.minimum === 'number' ? schema.minimum : undefined,
          maximum: isObj(schema) && typeof schema.maximum === 'number' ? schema.maximum : undefined,
          example: p.example ?? (isObj(schema) ? schema.example : undefined),
          default: isObj(schema) ? schema.default : undefined,
          explode: p.explode === undefined ? true : Boolean(p.explode),
          description: typeof p.description === 'string' ? p.description.slice(0, 300) : undefined,
        };
        merged.set(`${spec.in}:${spec.name}`, spec);
      }
    }

    endpoints.push({
      method: 'GET',
      path,
      server: serverUrl.replace(/\/+$/, ''),
      operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
      summary: typeof op.summary === 'string' ? op.summary : undefined,
      params: [...merged.values()],
      hasSecurity: (Array.isArray(op.security) ? op.security.length > 0 : rootSecurity),
      authSchemes: authSchemesFor(Array.isArray(op.security) ? op.security : doc.security),
    });
  }

  if (endpoints.length === 0) throw new SpecError('Spec has no GET endpoints without a request body; nothing to test');

  return {
    title: String(info.title ?? 'untitled'),
    version: String(info.version ?? ''),
    endpoints,
  };
}
