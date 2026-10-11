import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relaxSchemaForApi } from '../../src/llm/anthropic.js';
import { claimSchema, validateLlmClaim } from '../../src/worker/claims.js';

test('relaxSchemaForApi strips constraint keywords the API grammar rejects, keeps structure and enums', () => {
  const relaxed = relaxSchemaForApi({ type: 'object', additionalProperties: false, required: ['claims'], properties: { claims: { type: 'array', minItems: 1, maxItems: 12, items: claimSchema } } }) as {
    properties: { claims: Record<string, unknown> & { items: Record<string, unknown> } };
  };
  const arr = relaxed.properties.claims;
  assert.equal('minItems' in arr, false);
  assert.equal('maxItems' in arr, false);
  const item = arr.items as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, (claimSchema as { required: string[] }).required);
  assert.equal('pattern' in item.properties.endpoint, false);
  assert.equal('maxLength' in item.properties.statement, false);
  assert.equal('minimum' in item.properties.confidence, false);
  assert.deepEqual(item.properties.kind.enum, ['required', 'type', 'auth', 'pagination', 'error_behavior', 'undocumented_constraint', 'undocumented', 'other']);
  assert.ok(JSON.stringify(relaxed).indexOf('"title"') === -1);
});

test('the strict schema still enforces what the API does not', () => {
  const base = { statement: 'A perfectly fine statement about status 200.', endpoint: 'GET /v1/x', kind: 'other', param: null, verdict: 'observes', evidence: [{ trial_id: 1, status: 200 }], confidence: 0.5, diverges_from_spec: false, spec_says: null };
  assert.equal(validateLlmClaim(base), null);
  assert.match(validateLlmClaim({ ...base, statement: 'short' })!, /statement/);
  assert.match(validateLlmClaim({ ...base, endpoint: 'v1/x' })!, /endpoint/);
  assert.match(validateLlmClaim({ ...base, confidence: 1.5 })!, /confidence/);
  assert.match(validateLlmClaim({ ...base, evidence: [] })!, /evidence/);
});
