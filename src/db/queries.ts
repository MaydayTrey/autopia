/**
 * Read queries shared by the CLI, the MCP server, and the dashboard.
 * "Current claims" for a tool = claims of the latest finished run of its latest version.
 * Every claim view carries its EVIDENCE (the trials it cites) so a consumer
 * can see why to trust it.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';
import type { Claim, TestRun, Tool, ToolVersion, Trial } from './schema.js';
import { diffClaimSets, latestClaimsForVersion, type DiffEntry } from '../worker/diff.js';
import { siblingKey } from '../worker/claims.js';
import type { SiblingIndex } from '../worker/crossref.js';

export interface TrialRef {
  id: number;
  mutation_id: string;
  param: string | null;
  request: { method: string; url: string; query: [string, string][]; headers: Record<string, string> };
  status: number | null;
  error: string | null;
  latency_ms: number;
  response_preview: unknown;
}

export interface ClaimView {
  id: number;
  claim_key: string;
  statement: string;
  endpoint: string;
  kind: string;
  param: string | null;
  verdict: string;
  source: string;
  confidence: number;
  diverges_from_spec: boolean;
  divergence_type: string | null; // spec | sibling | null
  spec_says: string | null;
  sibling_note: string | null;
  verified: boolean;
  verified_by: string; // 'server' | 'contributor:<key prefix>'
  verified_at: Date;
  evidence: TrialRef[];
}

/**
 * Current verified claims of OTHER tools in the same category, indexed by
 * siblingKey, for cross-reference. Empty when the tool has no siblings yet.
 */
export async function siblingClaims(db: Db, toolId: number, category: string | null): Promise<SiblingIndex> {
  const index: SiblingIndex = new Map();
  if (!category) return index;
  const others = (await db.select().from(schema.tools).where(eq(schema.tools.category, category))).filter((t) => t.id !== toolId);
  for (const t of others) {
    const v = await resolveVersion(db, t.id, null);
    const cur = v ? await latestClaimsForVersion(db, v.id) : null;
    for (const c of cur?.claims ?? []) {
      const k = siblingKey(c.claimKey, c.source);
      if (!k) continue;
      index.set(k, [...(index.get(k) ?? []), { tool: t.name, verdict: c.verdict, statement: c.statement }]);
    }
  }
  return index;
}

export async function listTools(db: Db) {
  const tools = await db.select().from(schema.tools).orderBy(schema.tools.name);
  const out = [];
  for (const t of tools) {
    const versions = await db.select().from(schema.toolVersions).where(eq(schema.toolVersions.toolId, t.id)).orderBy(desc(schema.toolVersions.id));
    const latest = versions[0];
    const cur = latest ? await latestClaimsForVersion(db, latest.id) : null;
    out.push({
      id: t.id,
      name: t.name,
      kind: t.kind,
      category: t.category,
      tier: t.tier,
      versions: versions.length,
      latest_version_id: latest?.id ?? null,
      latest_version_label: latest?.versionLabel ?? null,
      verified_claims: cur?.claims.length ?? 0,
      divergences: cur?.claims.filter((c) => c.divergenceType).length ?? 0,
    });
  }
  return out;
}

export async function resolveTool(db: Db, name: string): Promise<Tool | null> {
  const [t] = await db.select().from(schema.tools).where(eq(schema.tools.name, name));
  return t ?? null;
}

export async function listVersions(db: Db, toolId: number): Promise<ToolVersion[]> {
  return db.select().from(schema.toolVersions).where(eq(schema.toolVersions.toolId, toolId)).orderBy(desc(schema.toolVersions.id));
}

export async function resolveVersion(db: Db, toolId: number, versionId?: number | null): Promise<ToolVersion | null> {
  if (versionId) {
    const [v] = await db.select().from(schema.toolVersions).where(and(eq(schema.toolVersions.id, versionId), eq(schema.toolVersions.toolId, toolId)));
    return v ?? null;
  }
  const [v] = await listVersions(db, toolId);
  return v ?? null;
}

export async function runsForTool(db: Db, toolId: number): Promise<(TestRun & { versionId: number })[]> {
  const rows = await db
    .select({ run: schema.testRuns, versionId: schema.toolVersions.id })
    .from(schema.testRuns)
    .innerJoin(schema.toolVersions, eq(schema.testRuns.toolVersionId, schema.toolVersions.id))
    .where(eq(schema.toolVersions.toolId, toolId))
    .orderBy(desc(schema.testRuns.id));
  return rows.map((r) => ({ ...r.run, versionId: r.versionId }));
}

export async function trialsByIds(db: Db, ids: number[]): Promise<Map<number, Trial>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select().from(schema.trials).where(inArray(schema.trials.id, ids));
  return new Map(rows.map((t) => [t.id, t]));
}

export async function trialById(db: Db, id: number): Promise<Trial | null> {
  const [t] = await db.select().from(schema.trials).where(eq(schema.trials.id, id));
  return t ?? null;
}

export function toTrialRef(t: Trial): TrialRef {
  const input = t.input as TrialRef['request'];
  return {
    id: t.id,
    mutation_id: t.mutationId,
    param: t.paramName,
    request: input,
    status: t.statusCode,
    error: t.errorText,
    latency_ms: t.latencyMs,
    response_preview: (t.response as { body?: unknown }).body ?? null,
  };
}

export async function withEvidence(db: Db, claims: Claim[]): Promise<ClaimView[]> {
  const ids = [...new Set(claims.flatMap((c) => c.evidenceTrialIds))];
  const trials = await trialsByIds(db, ids);
  return claims.map((c) => ({
    id: c.id,
    claim_key: c.claimKey,
    statement: c.statement,
    endpoint: c.endpoint,
    kind: c.kind,
    param: c.paramName,
    verdict: c.verdict,
    source: c.source,
    confidence: c.confidence,
    diverges_from_spec: c.divergenceType === 'spec',
    divergence_type: c.divergenceType,
    spec_says: c.specSays,
    sibling_note: c.siblingNote,
    verified: c.verified,
    verified_by: c.verifiedBy,
    verified_at: c.verifiedAt,
    evidence: c.evidenceTrialIds.map((id) => trials.get(id)).filter((t): t is Trial => !!t).map(toTrialRef),
  }));
}

/** Current verified claims for a tool (latest version by default), grouped by kind. */
export async function toolKnowledge(db: Db, toolName: string, versionId?: number | null, onlyDivergences = false) {
  const tool = await resolveTool(db, toolName);
  if (!tool) return null;
  const version = await resolveVersion(db, tool.id, versionId);
  if (!version) return { tool: tool.name, tier: tool.tier, version: null, run_id: null, claims: [], by_kind: {} };
  const cur = await latestClaimsForVersion(db, version.id);
  let claims = cur?.claims ?? [];
  if (onlyDivergences) claims = claims.filter((c) => c.divergenceType);
  claims = [...claims].sort((a, b) => Number(!!b.divergenceType) - Number(!!a.divergenceType) || a.kind.localeCompare(b.kind) || a.claimKey.localeCompare(b.claimKey));
  const views = await withEvidence(db, claims);
  const by_kind: Record<string, ClaimView[]> = {};
  for (const v of views) (by_kind[v.kind] ??= []).push(v);
  return { tool: tool.name, tier: tool.tier, version: { id: version.id, label: version.versionLabel, spec_url: version.specUrl, spec_hash: version.specHash, discovered_at: version.discoveredAt }, run_id: cur?.runId ?? null, claims: views, by_kind };
}

/** Text search over current claims. Postgres full-text first, ILIKE fallback for short/odd queries. */
export async function searchClaims(db: Db, query: string, toolName?: string | null, limit = 20): Promise<ClaimView[]> {
  const tools = toolName ? [await resolveTool(db, toolName)].filter((t): t is Tool => !!t) : await db.select().from(schema.tools);
  const runIds: number[] = [];
  for (const t of tools) {
    const v = await resolveVersion(db, t.id, null);
    const cur = v ? await latestClaimsForVersion(db, v.id) : null;
    if (cur) runIds.push(cur.runId);
  }
  if (runIds.length === 0) return [];
  const q = query.trim();
  // OR the meaningful words together and let ts_rank sort by how many match,
  // so a natural-language question ("is q required on /v1/items") finds the
  // claim about q even though no claim contains every word of the question.
  const terms = tokenize(q);
  let rows: Claim[] = [];
  if (terms.length) {
    const tsq = terms.join(' | ');
    const vec = sql`to_tsvector('english', ${schema.claims.statement} || ' ' || ${schema.claims.endpoint} || ' ' || coalesce(${schema.claims.paramName}, ''))`;
    const rank = sql<number>`ts_rank(${vec}, to_tsquery('english', ${tsq}))`;
    const fts = await db
      .select({ c: schema.claims, rank })
      .from(schema.claims)
      .where(and(inArray(schema.claims.testRunId, runIds), sql`${vec} @@ to_tsquery('english', ${tsq})`))
      .orderBy(desc(rank), schema.claims.id)
      .limit(limit);
    rows = fts.map((r) => r.c);
  }
  if (rows.length === 0) {
    const like = `%${q.replace(/[%_]/g, '')}%`;
    rows = await db
      .select()
      .from(schema.claims)
      .where(and(inArray(schema.claims.testRunId, runIds), sql`(${schema.claims.statement} ILIKE ${like} OR coalesce(${schema.claims.paramName}, '') ILIKE ${like})`))
      .limit(limit);
  }
  return withEvidence(db, rows);
}

export async function versionDiff(db: Db, toolName: string, fromVersionId: number, toVersionId: number) {
  const tool = await resolveTool(db, toolName);
  if (!tool) return null;
  const from = await latestClaimsForVersion(db, fromVersionId);
  const to = await latestClaimsForVersion(db, toVersionId);
  const entries: DiffEntry[] = diffClaimSets(from?.claims ?? [], to?.claims ?? []);
  const changes = entries.filter((e) => e.changeType !== 'unchanged');
  return {
    tool: tool.name,
    from_version_id: fromVersionId,
    to_version_id: toVersionId,
    counts: { unchanged: entries.length - changes.length, changed: changes.filter((e) => e.changeType === 'changed').length, added: changes.filter((e) => e.changeType === 'added').length, removed: changes.filter((e) => e.changeType === 'removed').length },
    changes: changes.map((e) => ({ claim_key: e.claimKey, change: e.changeType, before: e.from ? { statement: e.from.statement, verdict: e.from.verdict } : null, after: e.to ? { statement: e.to.statement, verdict: e.to.verdict } : null })),
  };
}

const STOPWORDS = new Set(['is', 'are', 'am', 'be', 'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'does', 'do', 'did', 'it', 'and', 'or', 'with', 'what', 'how', 'when', 'can', 'i', 'you', 'we', 'this', 'that', 'there', 'any', 'get', 'has', 'have']);

/** Query words safe for to_tsquery: alphanumerics only, stopwords dropped. */
export function tokenize(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w && !STOPWORDS.has(w)))].slice(0, 16);
}
