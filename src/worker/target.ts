/**
 * A TARGET file (targets/*.json) tells the worker what to study and how to be
 * polite about it. The spec supplies the endpoints and field list; the target
 * supplies known-valid baseline values where the spec has no example.
 */
import { readFile } from 'node:fs/promises';

export interface TargetConfig {
  name: string; // tool name in the DB, e.g. "open-meteo-forecast"
  category?: string; // for sibling comparisons later, e.g. "weather"
  spec_url: string; // http(s) URL, file:// URL, or local path to an OpenAPI 3.x doc
  /** Valid values for REQUIRED params, keyed by path then param name. */
  baseline?: Record<string, Record<string, string>>;
  /** Valid values for OPTIONAL params (used by optional_present probes). */
  optional_values?: Record<string, Record<string, string>>;
  /** Extra headers on every request (e.g. an API key header). */
  headers?: Record<string, string>;
  rate?: { concurrency?: number; min_interval_ms?: number };
  max_trials?: number;
  /** Only exercise these spec paths (exact match). Omit to exercise every GET endpoint. */
  include_paths?: string[];
  /** Base URL to use when the spec declares no absolute server; with override_server it replaces the declared one. */
  server?: string;
  /** Replace the spec's declared server with `server` (e.g. a regional mirror that serves the same API). */
  override_server?: boolean;
}

/** Apply include_paths; errors if a listed path is not in the spec (typo guard). */
export function selectEndpoints<T extends { path: string }>(endpoints: T[], target: TargetConfig): T[] {
  if (!target.include_paths || target.include_paths.length === 0) return endpoints;
  const have = new Set(endpoints.map((e) => e.path));
  const missing = target.include_paths.filter((p) => !have.has(p));
  if (missing.length) throw new Error(`target include_paths not found in spec: ${missing.join(', ')}`);
  const want = new Set(target.include_paths);
  return endpoints.filter((e) => want.has(e.path));
}

export async function loadTarget(file: string): Promise<TargetConfig> {
  const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<TargetConfig>;
  return validateTarget(raw);
}

export function validateTarget(raw: Partial<TargetConfig>): TargetConfig {
  if (!raw || typeof raw !== 'object') throw new Error('target: not an object');
  if (!raw.name || !/^[a-z0-9][a-z0-9-_]*$/i.test(raw.name)) throw new Error('target: "name" must be a slug like open-meteo-forecast');
  if (!raw.spec_url || typeof raw.spec_url !== 'string') throw new Error('target: "spec_url" is required');
  const c = raw.rate?.concurrency ?? 2;
  const i = raw.rate?.min_interval_ms ?? 150;
  if (c < 1 || c > 8) throw new Error('target: rate.concurrency must be 1..8 (be polite)');
  if (i < 0) throw new Error('target: rate.min_interval_ms must be >= 0');
  return {
    name: raw.name,
    category: raw.category,
    spec_url: raw.spec_url,
    baseline: raw.baseline ?? {},
    optional_values: raw.optional_values ?? {},
    headers: raw.headers ?? {},
    rate: { concurrency: c, min_interval_ms: i },
    max_trials: raw.max_trials ?? 500,
    include_paths: Array.isArray(raw.include_paths) ? raw.include_paths.map(String) : undefined,
    server: typeof raw.server === 'string' && /^https?:\/\//i.test(raw.server) ? raw.server.replace(/\/+$/, '') : undefined,
    override_server: raw.override_server === true,
  };
}
