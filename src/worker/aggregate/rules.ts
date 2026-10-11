/**
 * Stage 5.3 AGGREGATE, part 1: DETERMINISTIC RULES (no LLM).
 *
 * Most battery probes have a mechanical reading: "spec says required, omitted
 * it, got 200" is a divergence by definition. These rules turn trials into
 * candidate claims with zero model involvement, which makes them free,
 * deterministic, and easy to test. The LLM pass (llm.ts) handles only the
 * open-ended discovery these rules cannot express.
 *
 * Every rule cites its evidence trial ids and records what status each cited
 * trial showed, so VERIFY can check it mechanically.
 */
import type { Trial } from '../../db/schema.js';
import { ruleClaimKey, type CandidateClaim, type ClaimKind, type Verdict } from '../claims.js';
import { describeSignature, signaturesEqual, type ResponseSignature } from '../signature.js';
import { canonicalJson, type EndpointSpec, type ParamSpec, endpointLabel } from '../spec.js';

type Index = Map<string, Trial>; // mutation_id -> trial, for one endpoint

const sig = (t: Trial) => t.signature as unknown as ResponseSignature;
const ok = (t: Trial) => t.statusCode !== null && t.statusCode >= 200 && t.statusCode < 300;
const rejected = (t: Trial) => t.statusCode !== null && t.statusCode >= 400 && t.statusCode < 500;
const usable = (t: Trial) => t.statusCode !== null && t.errorText !== 'rate_limited';
const status = (t: Trial) => `HTTP ${t.statusCode}`;

function claim(
  rule: string,
  endpoint: string,
  param: string | null,
  kind: ClaimKind,
  verdict: Verdict,
  statement: string,
  evidence: Trial[],
  extra: Partial<Pick<CandidateClaim, 'diverges_from_spec' | 'spec_says' | 'confidence'>> = {},
): CandidateClaim {
  const conf = extra.confidence ?? (evidence.length >= 2 ? 0.9 : 0.7);
  return {
    claim_key: ruleClaimKey(rule, endpoint, param),
    statement,
    endpoint,
    kind,
    param,
    verdict,
    source: 'rules',
    confidence: conf,
    evidence_trial_ids: evidence.map((t) => t.id),
    expectations: evidence.map((t) => ({ trial_id: t.id, status: t.statusCode })),
    diverges_from_spec: extra.diverges_from_spec ?? false,
    spec_says: extra.spec_says ?? null,
  };
}

export function rulesClaims(trials: Trial[], endpoints: EndpointSpec[]): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  for (const ep of endpoints) {
    const label = endpointLabel(ep);
    const mine = trials.filter((t) => t.endpoint === label && usable(t));
    const idx: Index = new Map(mine.map((t) => [t.mutationId, t]));
    const params = new Map(ep.params.map((p) => [p.name, p]));
    out.push(...endpointRules(label, idx, params, mine));
  }
  return out;
}

function endpointRules(ep: string, idx: Index, params: Map<string, ParamSpec>, all: Trial[]): CandidateClaim[] {
  const out: CandidateClaim[] = [];
  const baseline = idx.get('baseline');
  if (!baseline) return out;

  // R1: baseline
  if (ok(baseline)) {
    out.push(claim('baseline', ep, null, 'other', 'observes', `A request with only the required parameters returns ${describeSignature(sig(baseline))}.`, [baseline]));
  } else {
    out.push(claim('baseline', ep, null, 'other', 'observes', `The baseline request (required parameters only, values from the target file) does not succeed: ${describeSignature(sig(baseline))}. Downstream claims for this endpoint are suppressed.`, [baseline], { confidence: 0.6 }));
    return out; // nothing else is interpretable without a working baseline
  }

  const baseFor = (t: Trial): Trial | undefined => {
    if (!t.paramName) return baseline;
    const p = params.get(t.paramName);
    return p && !p.required ? idx.get(`optional_present:${t.paramName}`) : baseline;
  };

  for (const t of all) {
    const p = t.paramName ? params.get(t.paramName) : undefined;
    const base = baseFor(t);
    if (!base || !ok(base)) continue; // optional_present failed; probes on that param are not interpretable
    const pn = t.paramName;
    const kindType: ClaimKind = 'type';
    const desc = describeSignature(sig(t));

    switch (t.mutationType) {
      case 'required_omitted':
        if (rejected(t)) out.push(claim('required_omitted', ep, pn, 'required', 'rejects', `Omitting required parameter "${pn}" is rejected with ${desc}.`, [base, t], { spec_says: 'required: true' }));
        else if (ok(t)) out.push(claim('required_omitted', ep, pn, 'required', 'accepts', `The spec marks "${pn}" as required, but omitting it still returns ${desc}.`, [base, t], { diverges_from_spec: true, spec_says: 'required: true' }));
        break;
      case 'required_all_omitted':
        if (rejected(t)) out.push(claim('required_all_omitted', ep, null, 'required', 'rejects', `Omitting every required parameter is rejected with ${desc}.`, [base, t]));
        else if (ok(t)) out.push(claim('required_all_omitted', ep, null, 'required', 'accepts', `Omitting every required parameter still returns ${desc}.`, [base, t], { diverges_from_spec: true, spec_says: 'all required parameters must be present' }));
        break;
      case 'optional_present':
        if (rejected(t)) out.push(claim('optional_present', ep, pn, 'other', 'rejects', `Documented optional parameter "${pn}" with value "${queryValue(t, pn)}" is rejected with ${desc}; either the value is invalid or the parameter is not accepted.`, [baseline, t], { confidence: 0.5 }));
        break;
      case 'wrong_type':
        if (!p) break;
        if (rejected(t)) out.push(claim('wrong_type', ep, pn, kindType, 'rejects', `Parameter "${pn}" (declared ${declaredType(p)}) rejects the non-${declaredType(p)} value "${queryValue(t, pn)}" with ${desc}.`, [base, t], { spec_says: `type: ${declaredType(p)}` }));
        else if (ok(t)) out.push(claim('wrong_type', ep, pn, kindType, 'accepts', `Parameter "${pn}" is declared ${declaredType(p)}, but the non-${declaredType(p)} value "${queryValue(t, pn)}" is accepted with ${desc}.`, [base, t], { diverges_from_spec: true, spec_says: `type: ${declaredType(p)}` }));
        break;
      case 'enum_invalid':
        if (!p) break;
        if (rejected(t)) out.push(claim('enum_invalid', ep, pn, kindType, 'rejects', `Parameter "${pn}" is validated against its documented enum: an undocumented value is rejected with ${desc}.`, [base, t], { spec_says: `enum of ${p.enum?.length ?? '?'} values` }));
        else if (ok(t)) out.push(claim('enum_invalid', ep, pn, kindType, 'accepts', `Parameter "${pn}" accepts a value outside its documented enum (${desc}).`, [base, t], { diverges_from_spec: true, spec_says: `enum of ${p.enum?.length ?? '?'} values` }));
        break;
      case 'null_value':
      case 'empty_value': {
        const what = t.mutationType === 'empty_value' ? 'an empty value' : 'the literal string "null"';
        if (rejected(t)) out.push(claim(t.mutationType, ep, pn, 'undocumented', 'rejects', `Sending ${what} for "${pn}" is rejected with ${desc}.`, [base, t]));
        else if (ok(t) && signaturesEqual(sig(t), sig(base))) out.push(claim(t.mutationType, ep, pn, 'undocumented', 'accepts', `Sending ${what} for "${pn}" is accepted and the response has the same shape as the comparison request (${status(t)}).`, [base, t]));
        else if (ok(t)) out.push(claim(t.mutationType, ep, pn, 'undocumented', 'accepts', `Sending ${what} for "${pn}" is accepted (${status(t)}) but changes the response shape compared with the comparison request.`, [base, t]));
        break;
      }
      case 'boundary_zero':
      case 'boundary_negative':
      case 'boundary_max_int':
      case 'boundary_long_string': {
        const v = queryValue(t, pn);
        const shown = v.length > 40 ? `${v.length}-character string` : `"${v}"`;
        if (rejected(t)) out.push(claim(t.mutationType, ep, pn, kindType, 'rejects', `Parameter "${pn}" rejects ${shown} with ${desc}.`, [base, t]));
        else if (ok(t)) out.push(claim(t.mutationType, ep, pn, kindType, 'accepts', `Parameter "${pn}" accepts ${shown} (${status(t)}).`, [base, t]));
        break;
      }
      case 'boundary_below_min':
      case 'boundary_above_max':
      case 'boundary_far_above_max': {
        if (!p) break;
        const bound = t.mutationType === 'boundary_below_min' ? `minimum ${p.minimum}` : `maximum ${p.maximum}`;
        const v = queryValue(t, pn);
        if (rejected(t)) out.push(claim(t.mutationType, ep, pn, kindType, 'rejects', `Parameter "${pn}" enforces its documented ${bound}: "${v}" is rejected with ${desc}.`, [base, t], { spec_says: bound }));
        else if (ok(t)) out.push(claim(t.mutationType, ep, pn, kindType, 'accepts', `The spec gives "${pn}" a ${bound}, but "${v}" is accepted (${desc}).`, [base, t], { diverges_from_spec: true, spec_says: bound }));
        break;
      }
      case 'duplicate_param':
        if (rejected(t)) out.push(claim('duplicate_param', ep, pn, 'undocumented', 'rejects', `Sending "${pn}" twice is rejected with ${desc}.`, [base, t]));
        else if (ok(t)) out.push(claim('duplicate_param', ep, pn, 'undocumented', 'accepts', `Sending "${pn}" twice with different values is accepted (${status(t)}).`, [base, t]));
        break;
      case 'extra_field':
        if (rejected(t)) out.push(claim('extra_field', ep, null, 'undocumented', 'rejects', `Unknown query parameters are rejected with ${desc}.`, [base, t]));
        else if (ok(t)) out.push(claim('extra_field', ep, null, 'undocumented', 'accepts', `Unknown query parameters are ignored (${status(t)}).`, [base, t]));
        break;
      case 'bad_auth':
        if (rejected(t)) out.push(claim('bad_auth', ep, null, 'auth', 'rejects', `An invalid credential is rejected with ${desc}.`, [base, t]));
        else if (ok(t)) out.push(claim('bad_auth', ep, null, 'auth', 'accepts', `An invalid credential value is accepted on this endpoint (${status(t)}); the credential is not enforced here.`, [base, t]));
        break;
      case 'pagination_zero':
      case 'pagination_huge':
      case 'pagination_beyond': {
        const v = queryValue(t, pn);
        if (rejected(t)) out.push(claim(t.mutationType, ep, pn, 'pagination', 'rejects', `Pagination parameter "${pn}" = ${v} is rejected with ${desc}.`, [base, t]));
        else if (ok(t)) out.push(claim(t.mutationType, ep, pn, 'pagination', 'accepts', `Pagination parameter "${pn}" = ${v} is accepted (${status(t)}).`, [base, t]));
        break;
      }
      case 'wrong_content_type': {
        const ct = (t.response as { headers?: Record<string, string> }).headers?.['content-type'] ?? 'unknown content-type';
        if (t.statusCode !== null) out.push(claim('wrong_content_type', ep, null, 'undocumented', 'observes', `Requesting XML via Accept/Content-Type headers yields ${status(t)} with content-type "${ct}".`, [base, t]));
        break;
      }
      case 'path_trailing_slash':
        if (t.statusCode !== null) out.push(claim('path_trailing_slash', ep, null, 'undocumented', 'observes', `The path with a trailing slash returns ${desc} (without it: ${status(base)}).`, [base, t]));
        break;
      case 'method_head':
        if (t.statusCode !== null) out.push(claim('method_head', ep, null, 'undocumented', 'observes', `HEAD with the baseline query returns ${status(t)}.`, [base, t]));
        break;
      default:
        break;
    }
  }

  // R15: error behavior. Do validation errors share one status + body shape?
  const errs = all.filter((t) => rejected(t) && t.mutationType !== 'bad_auth' && t.mutationType !== 'path_trailing_slash');
  if (errs.length >= 3) {
    const groups = new Map<string, Trial[]>();
    for (const t of errs) {
      const key = canonicalJson({ s: t.statusCode, shape: sig(t).shape });
      groups.set(key, [...(groups.get(key) ?? []), t]);
    }
    const [bigKey, big] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const share = big.length / errs.length;
    if (share >= 0.8) {
      const shape = JSON.parse(bigKey).shape;
      const evidence = big.slice(0, 8);
      out.push(
        claim('error_shape', ep, null, 'error_behavior', 'observes', `Validation errors consistently return HTTP ${big[0].statusCode} with a body of shape ${JSON.stringify(shape)} (${big.length} of ${errs.length} rejected probes).`, evidence, { confidence: Math.min(0.95, 0.6 + share * 0.35) }),
      );
    } else {
      const statuses = [...new Set(errs.map((t) => t.statusCode))].sort().join(', ');
      out.push(claim('error_shape', ep, null, 'error_behavior', 'observes', `Validation errors do not share one shape: ${groups.size} distinct status/shape combinations across ${errs.length} rejected probes (statuses ${statuses}).`, errs.slice(0, 8), { confidence: 0.6 }));
    }
  }

  return out;
}

function queryValue(t: Trial, param: string | null): string {
  if (!param) return '';
  const q = (t.input as { query?: [string, string][] }).query ?? [];
  const hit = q.filter(([k]) => k === param);
  return hit.length ? hit[hit.length - 1][1] : '';
}

function declaredType(p: ParamSpec): string {
  return p.type === 'array' ? `array<${p.itemType ?? 'unknown'}>` : p.type;
}
