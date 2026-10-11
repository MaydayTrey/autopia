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
- Every trial row names its comparison trial in the "compare_to" column (the request it should be judged against). When you cite a probe trial, ALSO cite its comparison trial, so the evidence shows the contrast and both must reproduce. A claim built from several probes cites each probe and the comparison they share.
- Make no claim that its cited trials do not directly support. If the trials are insufficient, make no claim. Prefer silence over guessing.
- Do not restate claims already listed under "Already claimed by rules".
- One sentence per statement, concrete, with the observed HTTP status. No speculation about causes.
- Kinds:
    required / type / auth / pagination / error_behavior: as named.
    undocumented_constraint: a rule the API enforces that the documented parameters never state, such as two parameters that must be sent together, an implicit default, or an ordering requirement. This is NOT a contradiction of the spec; set diverges_from_spec=false and describe the rule in the statement.
    response_shape: what a SUCCESSFUL response looks like and means, read from the body samples: the default timezone or offset of timestamps, whether missing data is null or an omitted key, what units values are in, which fields are pagination/metadata, how nested results are keyed. These are the questions a caller asks next after validation, so prefer them over more validation claims.
    undocumented: other behavior the documentation never mentions (redirects, extra response keys, tolerance of odd input).
    other: anything else.
- Do not add per-parameter validation claims that merely repeat a pattern the rules already cover for other parameters; one claim about the pattern, naming the exception if any, is worth more than ten about individual values.
- "diverges_from_spec" is true ONLY when a documented fact (required flag, type, enum, minimum/maximum) contradicts the observed behavior; then put the documented fact in "spec_says". Silence in the spec is never a divergence.
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
    const mine = trials.filter((t) => t.endpoint === label);
    const base = mine.find((t) => t.mutationId === 'baseline');
    // A sample of what success looks like, so response_shape claims can be grounded in it.
    const sampleFrom = [base, ...mine.filter((t) => t.mutationType === 'optional_present')].find((t) => t && t.statusCode !== null && t.statusCode < 300 && (t.response as { bodyKind?: string }).bodyKind === 'json');
    if (sampleFrom) {
      const r = sampleFrom.response as { headers?: Record<string, string>; body?: unknown };
      const hdr = Object.entries(r.headers ?? {}).filter(([k]) => /content-type|ratelimit|rate-limit|cache-control|used-weight/.test(k)).map(([k, v]) => `${k}: ${v}`).join('; ');
      lines.push(`Sample success response (trial ${sampleFrom.id}, ${sampleFrom.mutationId}; bodies are truncated to 5 array items / 200-char strings):`);
      if (hdr) lines.push(`headers: ${hdr}`);
      lines.push('```json', JSON.stringify(r.body).slice(0, 900), '```', '');
    }
    lines.push('Trials (id | probe | param | compare_to | query | status | body summary):');
    const optional = new Set(ep.params.filter((p) => !p.required).map((p) => p.name));
    const byMutation = new Map(mine.map((t) => [t.mutationId, t]));
    for (const t of mine) {
      const cmp = comparisonTrial(t, base, optional, byMutation);
      lines.push(`- ${t.id} | ${t.mutationId} | ${t.paramName ?? '-'} | ${cmp ? `#${cmp.id}` : '-'} | ${queryDiff(t, base)} | ${t.statusCode ?? 'no-response'} | ${bodySummary(t)}`);
    }
    lines.push('');
  }
  lines.push('## Already claimed by rules (do not repeat)');
  for (const k of known) lines.push(`- [${k.kind}] ${k.statement}`);
  return lines.join('\n');
}

/**
 * The trial a probe should be judged against: the baseline, or for a probe on
 * an OPTIONAL parameter, the optional_present trial for that parameter (same
 * logic the rules use). The baseline itself has no comparison.
 */
export function comparisonTrial(t: Trial, base: Trial | undefined, optionalParams: Set<string>, byMutation: Map<string, Trial>): Trial | undefined {
  if (t.mutationId === 'baseline') return undefined;
  if (t.paramName && optionalParams.has(t.paramName) && t.mutationType !== 'optional_present') {
    return byMutation.get(`optional_present:${t.paramName}`) ?? base;
  }
  return base;
}

function queryDiff(t: Trial, base?: Trial): string {
  const q = ((t.input as { query?: [string, string][] }).query ?? []).map(([k, v]) => `${k}=${v.length > 30 ? v.slice(0, 27) + '...' : v}`);
  const m = (t.input as { method?: string }).method;
  const u = (t.input as { url?: string }).url ?? '';
  const prefix = [m && m !== 'GET' ? m : '', u.endsWith('/') && base && !((base.input as { url?: string }).url ?? '').endsWith('/') ? 'trailing-slash' : ''].filter(Boolean).join(' ');
  const h = (t.input as { headers?: Record<string, string> }).headers ?? {};
  const hs = Object.entries(h).map(([k, v]) => (v === '' ? `NO-${k}-header` : `${k}:${v.length > 30 ? v.slice(0, 27) + '...' : v}`)).join(' ');
  // Path params: show only the ones that differ from the baseline's.
  const pp = (t.input as { pathParams?: Record<string, string> }).pathParams ?? {};
  const bpp = (base?.input as { pathParams?: Record<string, string> } | undefined)?.pathParams ?? {};
  const ps = Object.entries(pp).filter(([k, v]) => bpp[k] !== v).map(([k, v]) => `path ${k}=${v.length > 30 ? v.slice(0, 27) + '...' : v || '(empty)'}`).join(' ');
  return [prefix, ps, q.join('&') || '(none)', hs].filter(Boolean).join(' ');
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
