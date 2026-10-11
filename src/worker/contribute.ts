/**
 * CONTRIBUTOR TIER, local side. A contributor runs the worker on their own
 * machine (their API key, their model key, their database) and uploads a
 * BUNDLE that contains, by construction, nothing private:
 *
 *   tool      name, category, spec url + hash + label, the (public) spec document
 *   run       timing, battery hash, model + token counts
 *   trials    endpoint, probe id, param, STATUS, SIGNATURE (type shape only),
 *             input hash. NO inputs, NO headers, NO response bodies, NO
 *             error-message text.
 *   claims    statement, kind, param, verdict, source, confidence, divergence,
 *             evidence as trial refs with expected statuses.
 *
 * Statements are the one remaining leak path, so they are SCRUBBED: any
 * statement that looks like it carries an email, a token, or a long digit
 * run is rejected (locally before upload, and again on the server).
 */
import { desc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import type { ResponseSignature } from './signature.js';

export const BUNDLE_FORMAT = 'autopia-contribution/1';

export interface BundleTrial {
  ref: number; // id in the contributor's database; remapped on import
  endpoint: string;
  mutation_type: string;
  mutation_id: string;
  param: string | null;
  status: number | null;
  signature: ResponseSignature;
  input_hash: string;
}

export interface BundleClaim {
  claim_key: string;
  statement: string;
  endpoint: string;
  kind: string;
  param: string | null;
  verdict: string;
  source: string;
  confidence: number;
  divergence_type: string | null;
  spec_says: string | null;
  evidence: number[]; // trial refs
  expectations: { trial_id: number; status: number | null }[]; // trial refs
}

export interface ContributionBundle {
  format: typeof BUNDLE_FORMAT;
  tool: { name: string; category: string | null; spec_url: string; spec_hash: string; version_label: string | null; spec_blob: unknown };
  run: { started_at: string; finished_at: string; battery_hash: string; llm_model: string | null; llm_input_tokens: number; llm_output_tokens: number; trials: number };
  trials: BundleTrial[];
  claims: BundleClaim[];
}

const SCRUB_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'email address', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
  { name: 'API key or token', re: /\b(ak_[0-9A-Za-z]{10,}|sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|xox[a-z]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/ },
  { name: 'bearer credential', re: /bearer\s+[A-Za-z0-9._~+/=-]{12,}/i },
  { name: 'long hex string', re: /\b[0-9a-f]{32,}\b/i },
];

/**
 * Long digit runs can be account numbers, so they are flagged, except for the
 * numbers the battery itself sends (probe constants) and plausible epoch
 * timestamps, which rules claims quote as examples.
 */
const KNOWN_NUMBERS = new Set(['2147483648', '999999999', '100000']);
function suspiciousDigits(statement: string): boolean {
  for (const m of statement.match(/\b\d{9,}\b/g) ?? []) {
    if (KNOWN_NUMBERS.has(m)) continue;
    const n = Number(m);
    const epochSeconds = n >= 1_400_000_000 && n <= 2_200_000_000;
    const epochMillis = n >= 1_400_000_000_000 && n <= 2_200_000_000_000;
    if (epochSeconds || epochMillis) continue;
    return true;
  }
  return false;
}

/** Why a statement must not be published, or null if it is clean. Pure. */
export function scrubProblem(statement: string): string | null {
  for (const p of SCRUB_PATTERNS) if (p.re.test(statement)) return `statement contains what looks like an ${p.name}`;
  if (suspiciousDigits(statement)) return 'statement contains what looks like a long identifier number';
  return null;
}

export function scrubBundle(b: ContributionBundle): { clean: ContributionBundle; rejected: { claim_key: string; reason: string }[] } {
  const rejected: { claim_key: string; reason: string }[] = [];
  const claims = b.claims.filter((c) => {
    const why = scrubProblem(c.statement) ?? (c.spec_says ? scrubProblem(c.spec_says) : null);
    if (why) rejected.push({ claim_key: c.claim_key, reason: why });
    return !why;
  });
  return { clean: { ...b, claims }, rejected };
}

/** Build the bundle for a tool's latest finished run in the LOCAL database. */
export async function buildBundle(db: Db, toolName: string): Promise<ContributionBundle> {
  const [tool] = await db.select().from(schema.tools).where(eq(schema.tools.name, toolName));
  if (!tool) throw new Error(`no such tool locally: ${toolName}`);
  const [version] = await db.select().from(schema.toolVersions).where(eq(schema.toolVersions.toolId, tool.id)).orderBy(desc(schema.toolVersions.id));
  const runs = await db.select().from(schema.testRuns).where(eq(schema.testRuns.toolVersionId, version.id)).orderBy(desc(schema.testRuns.id));
  const run = runs.find((r) => r.status === 'finished');
  if (!run) throw new Error(`no finished run for ${toolName}`);
  const claims = await db.select().from(schema.claims).where(eq(schema.claims.testRunId, run.id));
  if (!claims.length) throw new Error(`run #${run.id} stored no claims; nothing to contribute`);
  const needed = new Set(claims.flatMap((c) => c.evidenceTrialIds));
  const trials = (await db.select().from(schema.trials).where(eq(schema.trials.testRunId, run.id))).filter((t) => needed.has(t.id));

  return {
    format: BUNDLE_FORMAT,
    tool: { name: tool.name, category: tool.category, spec_url: version.specUrl, spec_hash: version.specHash, version_label: version.versionLabel, spec_blob: version.specBlob },
    run: { started_at: run.startedAt.toISOString(), finished_at: (run.finishedAt ?? new Date()).toISOString(), battery_hash: run.batteryHash, llm_model: run.llmModel, llm_input_tokens: run.llmInputTokens, llm_output_tokens: run.llmOutputTokens, trials: (run.stats as { trials?: number }).trials ?? trials.length },
    trials: trials.map((t) => ({ ref: t.id, endpoint: t.endpoint, mutation_type: t.mutationType, mutation_id: t.mutationId, param: t.paramName, status: t.statusCode, signature: stripSignature(t.signature as unknown as ResponseSignature), input_hash: t.inputHash })),
    claims: claims.map((c) => ({
      claim_key: c.claimKey,
      statement: c.statement,
      endpoint: c.endpoint,
      kind: c.kind,
      param: c.paramName,
      verdict: c.verdict,
      source: c.source,
      confidence: c.confidence,
      divergence_type: c.divergenceType,
      spec_says: c.specSays,
      evidence: c.evidenceTrialIds,
      expectations: c.expectations as { trial_id: number; status: number | null }[],
    })),
  };
}

/** Signature minus the error message text (free text from the API could carry identifiers). */
function stripSignature(s: ResponseSignature): ResponseSignature {
  return { status: s.status, bodyKind: s.bodyKind, shape: s.shape, errorMessage: s.errorMessage ? '[omitted in contribution]' : null, transportError: s.transportError };
}

/** Structural check that a bundle carries nothing it must not. Pure. */
export function bundleProblem(b: unknown): string | null {
  if (!b || typeof b !== 'object') return 'bundle is not an object';
  const x = b as Partial<ContributionBundle>;
  if (x.format !== BUNDLE_FORMAT) return `unknown bundle format ${String(x.format)}`;
  if (!x.tool?.name || !/^[a-z0-9][a-z0-9-_]*$/i.test(x.tool.name)) return 'tool.name missing or not a slug';
  if (!x.tool.spec_url || !x.tool.spec_hash) return 'tool.spec_url and tool.spec_hash are required';
  if (!Array.isArray(x.trials) || !Array.isArray(x.claims)) return 'trials and claims must be arrays';
  if (x.trials.length > 5000 || x.claims.length > 5000) return 'bundle too large';
  for (const t of x.trials) {
    if ('input' in (t as object) || 'response' in (t as object) || 'headers' in (t as object) || 'body' in (t as object)) return 'trials must not carry inputs, headers, or bodies';
    if (typeof (t as BundleTrial).ref !== 'number' || typeof (t as BundleTrial).endpoint !== 'string' || typeof (t as BundleTrial).mutation_id !== 'string') return 'trial missing ref/endpoint/mutation_id';
  }
  const refs = new Set(x.trials.map((t) => t.ref));
  for (const c of x.claims) {
    if (typeof c.statement !== 'string' || !c.claim_key || !c.endpoint) return 'claim missing statement/claim_key/endpoint';
    if (!Array.isArray(c.evidence) || c.evidence.length === 0 || !c.evidence.every((r) => refs.has(r))) return `claim ${c.claim_key} cites evidence not in the bundle`;
  }
  return null;
}
