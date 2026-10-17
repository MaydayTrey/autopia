/**
 * The CLAIM shape shared by every stage after EXERCISE.
 *
 * A claim is a hypothesis until VERIFY confirms its cited trials reproduce;
 * then it is a fact with a receipt. No evidence, no claim.
 *
 *   claim_key     stable identity across runs and versions (drives diffs and
 *                 the determinism check). Rules: "rule:<rule>:<endpoint>:<param>".
 *                 LLM: "llm:<kind>:<endpoint>:<param>:<verdict>:<mutation ids>".
 *   expectations  what each cited trial must show (its HTTP status). This makes
 *                 the evidence check mechanical for rule AND LLM claims.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv, type ValidateFunction } from 'ajv';
import type { Trial } from '../db/schema.js';

export const CLAIM_KINDS = ['required', 'type', 'auth', 'pagination', 'error_behavior', 'response_shape', 'undocumented_constraint', 'undocumented', 'other'] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
export const VERDICTS = ['accepts', 'rejects', 'observes'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface Expectation {
  trial_id: number;
  status: number | null; // null = no HTTP response (transport error)
}

export interface CandidateClaim {
  claim_key: string;
  statement: string;
  endpoint: string;
  kind: ClaimKind;
  param: string | null;
  verdict: Verdict;
  source: 'rules' | 'llm' | 'scenario';
  confidence: number; // 0..1
  evidence_trial_ids: number[];
  expectations: Expectation[];
  diverges_from_spec: boolean;
  spec_says: string | null;
  /** Set by cross-ref when a sibling tool (same category) shows the opposite verdict for the same probe. */
  diverges_from_sibling?: boolean;
  sibling_note?: string | null;
}

/**
 * Identity of a rules claim ACROSS tools: the rule and the parameter, minus
 * the endpoint. Lets "does forecast ignore unknown params?" be compared with
 * "does air-quality ignore unknown params?". LLM claims have no sibling key
 * (their keys embed probe sets that rarely line up across tools).
 */
export function siblingKey(claimKey: string, source: string): string | null {
  if (source !== 'rules') return null;
  const m = claimKey.match(/^rule:([^:]+):[^:]+:(.*)$/);
  return m ? `rule:${m[1]}:${m[2]}` : null;
}

/** What the LLM is asked to return (a subset of CandidateClaim; we derive the rest). */
export interface LlmClaimOutput {
  statement: string;
  endpoint: string;
  kind: ClaimKind;
  param: string | null;
  verdict: Verdict;
  evidence: Expectation[];
  confidence: number;
  diverges_from_spec: boolean;
  spec_says: string | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLAIM_SCHEMA_PATH = path.resolve(here, '..', 'schemas', 'claim.schema.json');
export const claimSchema = JSON.parse(readFileSync(CLAIM_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;

let validator: ValidateFunction | null = null;
export function claimValidator(): ValidateFunction {
  if (validator) return validator;
  const ajv = new Ajv({ allErrors: true, strict: true });
  const v = ajv.compile(claimSchema);
  validator = v;
  return v;
}

/** Validate one LLM-returned object; returns the error text or null if valid. */
export function validateLlmClaim(obj: unknown): string | null {
  const v = claimValidator();
  if (v(obj)) return null;
  return (v.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`).join('; ');
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** Stable key for an LLM claim: about-what + verdict + which battery probes it cites. */
export function llmClaimKey(c: LlmClaimOutput, trialsById: Map<number, Trial>): string {
  const probes = [...new Set(c.evidence.map((e) => trialsById.get(e.trial_id)?.mutationId ?? '?'))].sort().join('+');
  return `llm:${c.kind}:${slug(c.endpoint)}:${c.param ?? '-'}:${c.verdict}:${probes}`;
}

export function ruleClaimKey(rule: string, endpoint: string, param: string | null): string {
  return `rule:${rule}:${slug(endpoint)}:${param ?? '-'}`;
}

/** Scenario claims: "scenario:<check>:<endpoint>:<param or ->". One claim per invariant per endpoint (per parameter for filters); stable across runs. */
export function scenarioClaimKey(check: string, endpoint: string, param: string | null = null): string {
  return `scenario:${check}:${slug(endpoint)}:${param ? slug(param) : '-'}`;
}
