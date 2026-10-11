/**
 * Stage 5.4 CROSS-REFERENCE (pure logic, no LLM, no network)
 *
 *   (a) SPEC: for claim kinds where the spec has an opinion (required, type
 *       with a declared type/enum/range), recompute divergence mechanically
 *       from the parsed spec. The LLM's own flag is kept only where we cannot
 *       decide mechanically.
 *   (b) SIBLINGS: deferred until >= 2 tools share a category (open question
 *       in the spec). Logged, not implemented.
 *   (c) SELF-CONSISTENCY: claims that contradict each other are QUARANTINED,
 *       not stored. Two mechanical contradiction tests:
 *         1. two claims cite the same trial but expect different statuses
 *         2. same endpoint+kind+param, one says "accepts" the other "rejects",
 *            and they share at least one evidence trial
 *       Exact duplicate claim_keys keep the first (rules precede LLM).
 */
import type { CandidateClaim } from './claims.js';
import { log } from './log.js';
import { endpointLabel, type EndpointSpec, type ParamSpec } from './spec.js';

export interface CrossRefResult {
  kept: CandidateClaim[];
  quarantined: { claim: CandidateClaim; reason: string }[];
}

export function crossReference(claims: CandidateClaim[], endpoints: EndpointSpec[]): CrossRefResult {
  const params = new Map<string, Map<string, ParamSpec>>();
  for (const ep of endpoints) params.set(endpointLabel(ep), new Map(ep.params.map((p) => [p.name, p])));

  // (a) spec tagging
  const tagged = claims.map((c) => tagAgainstSpec(c, params.get(c.endpoint)));

  // dedupe by key
  const byKey = new Map<string, CandidateClaim>();
  const quarantined: CrossRefResult['quarantined'] = [];
  for (const c of tagged) {
    if (byKey.has(c.claim_key)) quarantined.push({ claim: c, reason: `duplicate claim_key ${c.claim_key}` });
    else byKey.set(c.claim_key, c);
  }
  let kept = [...byKey.values()];

  // (c) self-consistency
  const bad = new Map<string, string>(); // claim_key -> reason
  const byTrial = new Map<number, { key: string; status: number | null }[]>();
  for (const c of kept) {
    for (const e of c.expectations) byTrial.set(e.trial_id, [...(byTrial.get(e.trial_id) ?? []), { key: c.claim_key, status: e.status }]);
  }
  for (const [trialId, exps] of byTrial) {
    const statuses = new Set(exps.map((e) => e.status));
    if (statuses.size > 1) for (const e of exps) bad.set(e.key, `contradiction: trial ${trialId} expected ${[...statuses].join(' vs ')}`);
  }
  const bySubject = new Map<string, CandidateClaim[]>();
  for (const c of kept) {
    const s = `${c.endpoint}|${c.kind}|${c.param ?? '-'}`;
    bySubject.set(s, [...(bySubject.get(s) ?? []), c]);
  }
  // Two claims about the same subject with opposite verdicts contradict only if
  // they rest on the SAME evidence. Different probes (e.g. empty value vs
  // literal "null") share the comparison baseline but are about different
  // inputs, so they may legitimately disagree.
  const evidenceSet = (c: CandidateClaim) => [...c.evidence_trial_ids].sort((x, y) => x - y).join(',');
  for (const [subject, group] of bySubject) {
    const acc = group.filter((c) => c.verdict === 'accepts');
    const rej = group.filter((c) => c.verdict === 'rejects');
    for (const a of acc)
      for (const r of rej)
        if (evidenceSet(a) === evidenceSet(r)) {
          bad.set(a.claim_key, `contradiction on ${subject}: accepts vs rejects over identical evidence`);
          bad.set(r.claim_key, `contradiction on ${subject}: accepts vs rejects over identical evidence`);
        }
  }
  for (const c of kept) if (bad.has(c.claim_key)) quarantined.push({ claim: c, reason: bad.get(c.claim_key)! });
  kept = kept.filter((c) => !bad.has(c.claim_key));

  // (b) siblings: not yet
  log.debug('crossref', 'sibling-tool comparison skipped (needs >= 2 tools in a category)');
  for (const q of quarantined) log.warn('crossref', `quarantined: ${q.reason}`, { statement: q.claim.statement });
  log.info('crossref', `${kept.length} claims kept, ${quarantined.length} quarantined, ${kept.filter((c) => c.diverges_from_spec).length} diverge from spec`);
  return { kept, quarantined };
}

/** Mechanical spec comparison where the spec has an opinion. */
export function tagAgainstSpec(c: CandidateClaim, params?: Map<string, ParamSpec>): CandidateClaim {
  const p = c.param && params ? params.get(c.param) : undefined;
  if (c.kind === 'required' && p) {
    if (p.required && c.verdict === 'accepts') return { ...c, diverges_from_spec: true, spec_says: c.spec_says ?? 'required: true' };
    if (!p.required && c.verdict === 'rejects') return { ...c, diverges_from_spec: true, spec_says: c.spec_says ?? 'required: false' };
    if (p.required && c.verdict === 'rejects') return { ...c, diverges_from_spec: false, spec_says: c.spec_says ?? 'required: true' };
  }
  if (c.kind === 'type' && p && c.source === 'rules') {
    // rules already know; nothing to change
    return c;
  }
  return c; // keep the source's own flag
}
