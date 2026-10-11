/**
 * Stage 5.3 AGGREGATE, part 2: ONE batched LLM pass (section 7.1).
 *
 * The prompt is a CONTRACT, not a chat:
 *   - input is the aggregated trial summary (grouped by endpoint + mutation)
 *     plus the list of claims the rules already made, so the model spends its
 *     effort on what the rules cannot see (open-ended, undocumented behavior).
 *   - output is {"claims":[...]} where every item matches
 *     src/schemas/claim.schema.json. Each object is ajv-validated; invalid ones
 *     are discarded and logged, never retried blindly.
 *   - rules in the prompt: cite only real trial ids; every claim must be
 *     supported by its cited trials; prefer no claim over a guess.
 */
import type { Trial } from '../../db/schema.js';
import type { LlmAdapter } from '../../llm/adapter.js';
import { claimSchema, llmClaimKey, validateLlmClaim, type CandidateClaim, type LlmClaimOutput } from '../claims.js';
import { log } from '../log.js';
import type { ResponseSignature } from '../signature.js';
import { endpointLabel, type EndpointSpec } from '../spec.js';

export interface LlmPassResult {
  claims: CandidateClaim[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
  discarded: { reason: string; raw: unknown }[];
}

export const SYSTEM_PROMPT = `You are the interpretation stage of Autopia, a system that empirically tests HTTP APIs and records only behaviors that are backed by logged evidence.

You will receive (1) the documented parameters of each endpoint, (2) a table of TRIALS: pinned requests that were actually sent and the responses they produced, and (3) claims that deterministic rules have already derived. Your job is to find ADDITIONAL behavioral claims the rules did not state, with emphasis on behavior the documentation never mentioned.

Rules of this contract:
- Cite only trial ids that appear in the table. For each cited trial, report the exact HTTP status shown in the table.
- Make no claim that its cited trials do not directly support. If the trials are insufficient, make no claim. Prefer silence over guessing.
- Do not restate claims already listed under "Already claimed by rules".
- One sentence per statement, concrete, with the observed HTTP status. No speculation about causes.
- "diverges_from_spec" is true only when the documented parameters contradict the observed behavior; then put the documented fact in "spec_says".
- Return at most 25 claims. Fewer, well-supported claims are better.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims'],
  properties: { claims: { type: 'array', items: claimSchema } },
};

export function buildSummary(trials: Trial[], endpoints: EndpointSpec[], known: CandidateClaim[]): string {
  const lines: string[] = [];
  for (const ep of endpoints) {
    const label = endpointLabel(ep);
    lines.push(`## ${label}`);
    lines.push('Documented parameters (name | in | required | type | constraints):');
    for (const p of ep.params) {
      const c = [p.enum ? `enum[${p.enum.length}]` : '', p.minimum !== undefined ? `min=${p.minimum}` : '', p.maximum !== undefined ? `max=${p.maximum}` : '', p.format ? `format=${p.format}` : ''].filter(Boolean).join(' ');
      lines.push(`- ${p.name} | ${p.in} | ${p.required ? 'required' : 'optional'} | ${p.type}${p.itemType ? `<${p.itemType}>` : ''} | ${c || '-'}`);
    }
    lines.push('');
    lines.push('Trials (id | probe | param | query | status | body summary):');
    const base = trials.find((t) => t.endpoint === label && t.mutationId === 'baseline');
    for (const t of trials.filter((t) => t.endpoint === label)) {
      lines.push(`- ${t.id} | ${t.mutationId} | ${t.paramName ?? '-'} | ${queryDiff(t, base)} | ${t.statusCode ?? 'no-response'} | ${bodySummary(t)}`);
    }
    lines.push('');
  }
  lines.push('## Already claimed by rules (do not repeat)');
  for (const k of known) lines.push(`- [${k.kind}] ${k.statement}`);
  return lines.join('\n');
}

function queryDiff(t: Trial, base?: Trial): string {
  const q = ((t.input as { query?: [string, string][] }).query ?? []).map(([k, v]) => `${k}=${v.length > 30 ? v.slice(0, 27) + '...' : v}`);
  const m = (t.input as { method?: string }).method;
  const u = (t.input as { url?: string }).url ?? '';
  const prefix = [m && m !== 'GET' ? m : '', u.endsWith('/') && base && !((base.input as { url?: string }).url ?? '').endsWith('/') ? 'trailing-slash' : ''].filter(Boolean).join(' ');
  const h = (t.input as { headers?: Record<string, string> }).headers ?? {};
  const hs = Object.entries(h).filter(([k]) => k !== 'user-agent').map(([k, v]) => `${k}:${v}`).join(' ');
  return [prefix, q.join('&') || '(none)', hs].filter(Boolean).join(' ');
}

function bodySummary(t: Trial): string {
  const s = t.signature as unknown as ResponseSignature;
  if (s.transportError) return `transport: ${s.transportError}`;
  if (s.errorMessage) return `error: "${s.errorMessage.slice(0, 120)}"`;
  const r = t.response as { headers?: Record<string, string>; bodyKind?: string };
  if (s.bodyKind === 'json' && s.shape && typeof s.shape === 'object' && !Array.isArray(s.shape)) return `json keys: ${Object.keys(s.shape as object).slice(0, 12).join(',')}`;
  return `${s.bodyKind}${r.headers?.['content-type'] ? ` (${r.headers['content-type']})` : ''}`;
}

export async function llmClaims(adapter: LlmAdapter, trials: Trial[], endpoints: EndpointSpec[], known: CandidateClaim[]): Promise<LlmPassResult> {
  const user = buildSummary(trials, endpoints, known);
  log.info('aggregate', `LLM pass via ${adapter.name}: ${trials.length} trials, ${known.length} known claims, ${user.length} chars`);
  const res = await adapter.complete({ system: SYSTEM_PROMPT, user, jsonSchema: RESPONSE_SCHEMA, maxTokens: 16_000 });
  const discarded: LlmPassResult['discarded'] = [];
  const byId = new Map(trials.map((t) => [t.id, t]));
  const claims: CandidateClaim[] = [];

  if (res.refused) {
    log.warn('aggregate', 'model refused the interpretation request; no LLM claims this run');
    return { claims, usage: res.usage, model: res.model, discarded: [{ reason: 'refusal', raw: null }] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.text);
  } catch (e) {
    log.warn('aggregate', `LLM output is not JSON: ${(e as Error).message}`);
    return { claims, usage: res.usage, model: res.model, discarded: [{ reason: 'not json', raw: res.text.slice(0, 500) }] };
  }
  const items = (parsed as { claims?: unknown })?.claims;
  if (!Array.isArray(items)) {
    return { claims, usage: res.usage, model: res.model, discarded: [{ reason: 'missing claims array', raw: parsed }] };
  }

  const seen = new Set<string>();
  for (const raw of items) {
    const err = validateLlmClaim(raw);
    if (err) {
      discarded.push({ reason: `schema: ${err}`, raw });
      continue;
    }
    const c = raw as LlmClaimOutput;
    const unknownIds = c.evidence.filter((e) => !byId.has(e.trial_id)).map((e) => e.trial_id);
    if (unknownIds.length) {
      discarded.push({ reason: `cites unknown trial ids ${unknownIds.join(',')}`, raw });
      continue;
    }
    const key = llmClaimKey(c, byId);
    if (seen.has(key)) {
      discarded.push({ reason: `duplicate key ${key}`, raw });
      continue;
    }
    seen.add(key);
    claims.push({
      claim_key: key,
      statement: c.statement,
      endpoint: c.endpoint,
      kind: c.kind,
      param: c.param,
      verdict: c.verdict,
      source: 'llm',
      confidence: c.confidence,
      evidence_trial_ids: c.evidence.map((e) => e.trial_id),
      expectations: c.evidence,
      diverges_from_spec: c.diverges_from_spec,
      spec_says: c.spec_says,
    });
  }
  for (const d of discarded) log.warn('aggregate', `discarded LLM claim: ${d.reason}`, d.raw);
  log.info('aggregate', `LLM pass: ${claims.length} candidate claims, ${discarded.length} discarded, tokens in/out ${res.usage.inputTokens}/${res.usage.outputTokens}`);
  return { claims, usage: res.usage, model: res.model, discarded };
}
