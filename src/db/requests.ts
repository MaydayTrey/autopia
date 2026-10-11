/**
 * USER-REQUESTED TARGETS.
 *
 * A keyed user submits a target over MCP. We check SCOPE before storing it:
 *   - public http(s) hosts only (no localhost, private ranges, IP literals,
 *     .internal/.local names) for both spec_url and server: the worker would
 *     otherwise be a request proxy into wherever it runs
 *   - keyless: no headers at all (credentials are the contributor tier's job)
 *   - the spec must fetch and parse as OpenAPI 3 with at least one GET
 *   - caps we control: concurrency 1, spacing >= 300ms, <= 300 trials
 *   - a name not already used by a file target or another request
 *   - per-key quota: REQUESTS_PER_DAY submissions a day
 * The worker processes pending requests rules-only (no model cost). Once
 * 'done', the stored target joins every later run-all pass.
 */
import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';
import type { TargetRequest } from './schema.js';
import { extractEndpoints, fetchSpecText, parseSpecText, SpecError } from '../worker/spec.js';
import { selectEndpoints, validateTarget, type TargetConfig } from '../worker/target.js';
import { planAll } from '../worker/exercise.js';

export const REQUESTS_PER_DAY = 3;
export const MAX_TRIALS_FOR_REQUESTS = 300;

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home|.*\.lan|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?fc[0-9a-f]{2}:.*|\[?fd[0-9a-f]{2}:.*|\[?fe80:.*)$/i;
const IP_LITERAL = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/;

/** Reject anything that is not a public DNS name over http(s). Pure. */
export function publicHostProblem(url: string): string | null {
  // Tests run a mock API on 127.0.0.1; never set this in a deployment.
  if (process.env.AUTOPIA_ALLOW_PRIVATE_HOSTS === '1') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `not a URL: ${url}`;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return `only http(s) URLs are accepted (${u.protocol})`;
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host)) return `host "${host}" is private or local`;
  if (IP_LITERAL.test(host)) return `host "${host}" is an IP literal; use a public DNS name`;
  if (!host.includes('.')) return `host "${host}" is not a public DNS name`;
  if (u.username || u.password) return 'credentials in the URL are not accepted';
  return null;
}

/** Scope checks that need no network. Pure. Returns the normalized target or throws. */
export function checkScope(raw: unknown): TargetConfig {
  if (!raw || typeof raw !== 'object') throw new Error('target must be a JSON object');
  const r = raw as Record<string, unknown>;
  if (r.headers && Object.keys(r.headers as object).length) throw new Error('headers are not accepted: requested targets must be keyless (credentials belong to the contributor tier)');
  const t = validateTarget(r as Partial<TargetConfig>);
  const specProblem = publicHostProblem(t.spec_url);
  if (specProblem) throw new Error(`spec_url: ${specProblem}`);
  if (t.server) {
    const p = publicHostProblem(t.server);
    if (p) throw new Error(`server: ${p}`);
  }
  // caps we control, regardless of what was submitted
  t.rate = { concurrency: 1, min_interval_ms: Math.max(300, t.rate?.min_interval_ms ?? 300) };
  t.max_trials = Math.min(t.max_trials ?? MAX_TRIALS_FOR_REQUESTS, MAX_TRIALS_FOR_REQUESTS);
  t.headers = {};
  return t;
}

/** Fetch + parse the spec and plan the battery, so the user learns up front what will run. */
export async function inspectTarget(t: TargetConfig): Promise<{ title: string; version: string; endpoints: number; trials: number; servers: string[] }> {
  const doc = parseSpecText(await fetchSpecText(t.spec_url));
  const parsed = extractEndpoints(doc, { server: t.server, overrideServer: t.override_server });
  const endpoints = selectEndpoints(parsed.endpoints, t);
  for (const ep of endpoints) {
    const p = publicHostProblem(ep.server);
    if (p) throw new SpecError(`spec server for ${ep.path}: ${p}`);
  }
  const plan = planAll(endpoints, t, t.max_trials ?? MAX_TRIALS_FOR_REQUESTS);
  return { title: parsed.title, version: parsed.version, endpoints: endpoints.length, trials: plan.length, servers: [...new Set(endpoints.map((e) => e.server))] };
}

export interface SubmitResult {
  request: TargetRequest;
  inspection: Awaited<ReturnType<typeof inspectTarget>>;
}

export async function submitRequest(db: Db, keyId: number | null, raw: unknown, now = new Date()): Promise<SubmitResult> {
  const t = checkScope(raw);
  // quota per key per UTC day (admin token: unlimited)
  if (keyId !== null) {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.targetRequests).where(and(eq(schema.targetRequests.keyId, keyId), gte(schema.targetRequests.createdAt, dayStart)));
    if (Number(n) >= REQUESTS_PER_DAY) throw new Error(`quota: ${REQUESTS_PER_DAY} target requests per day per key`);
  }
  // name must be free
  const [tool] = await db.select().from(schema.tools).where(eq(schema.tools.name, t.name));
  if (tool) throw new Error(`a tool named "${t.name}" already exists in the compendium (use get_tool_docs)`);
  const [dup] = await db.select().from(schema.targetRequests).where(eq(schema.targetRequests.name, t.name));
  if (dup) throw new Error(`a request named "${t.name}" already exists (status ${dup.status}, id ${dup.id})`);

  const inspection = await inspectTarget(t); // throws SpecError on out-of-scope specs
  const [request] = await db
    .insert(schema.targetRequests)
    .values({ keyId, name: t.name, specUrl: t.spec_url, target: t as unknown as object, status: 'pending', note: `${inspection.title} v${inspection.version}: ${inspection.endpoints} endpoint(s), ${inspection.trials} trials planned` })
    .returning();
  return { request, inspection };
}

export async function getRequest(db: Db, id: number): Promise<TargetRequest | null> {
  const [r] = await db.select().from(schema.targetRequests).where(eq(schema.targetRequests.id, id));
  return r ?? null;
}

export async function listRequests(db: Db, statuses?: string[]): Promise<TargetRequest[]> {
  const q = db.select().from(schema.targetRequests);
  const rows = statuses?.length ? await q.where(inArray(schema.targetRequests.status, statuses)).orderBy(desc(schema.targetRequests.id)) : await q.orderBy(desc(schema.targetRequests.id));
  return rows;
}

export async function markRequest(db: Db, id: number, patch: { status: string; note?: string | null; testRunId?: number | null; startedAt?: Date; finishedAt?: Date }): Promise<void> {
  await db.update(schema.targetRequests).set(patch).where(eq(schema.targetRequests.id, id));
}

/** Targets that have been processed successfully: they join every run-all pass. */
export async function acceptedTargets(db: Db): Promise<TargetConfig[]> {
  const rows = await listRequests(db, ['done']);
  return rows.map((r) => r.target as unknown as TargetConfig);
}
