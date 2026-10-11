import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUNDLE_FORMAT, bundleProblem, scrubBundle, scrubProblem, type ContributionBundle } from '../../src/worker/contribute.js';

test('scrubProblem flags emails, tokens, bearer credentials, long hex, long digit runs; passes normal statements', () => {
  assert.match(scrubProblem('Contact jane.doe@example.com for access')!, /email/);
  assert.match(scrubProblem('Key ak_abcdefghijklmnopqrstuvwxyz0123456789ABCD accepted')!, /token/);
  assert.match(scrubProblem('sk-live-abcdefghijkl accepted')!, /token/);
  assert.match(scrubProblem('Header Bearer abcdefghijklmnop123456 is required')!, /bearer/);
  assert.match(scrubProblem('Returns id 0123456789abcdef0123456789abcdef')!, /hex/);
  assert.match(scrubProblem('Account 123456789012 is not found')!, /identifier number/);
  // battery constants and plausible epoch timestamps are the numbers rules claims legitimately quote
  for (const ok of [
    'Omitting required parameter "latitude" is rejected with HTTP 400.',
    'The spec gives "past_days" a maximum 92, but "93" is accepted (HTTP 200 JSON).',
    'Timestamps are Unix epoch milliseconds (e.g. 1704067200000). Epoch values are UTC by definition.',
    'Pagination parameter "limit" = 999999999 is rejected with HTTP 400.',
    'Parameter "limit" rejects "2147483648" with HTTP 400.',
  ]) {
    assert.equal(scrubProblem(ok), null, ok);
  }
  assert.equal(scrubProblem('Unknown query parameters are ignored (HTTP 200).'), null);
  assert.equal(scrubProblem('Parameter "limit" rejects "abc" with HTTP 422.'), null);
});

function bundle(over: Partial<ContributionBundle> = {}): ContributionBundle {
  return {
    format: BUNDLE_FORMAT,
    tool: { name: 'keyed-api', category: 'test', spec_url: 'https://example.com/openapi.json', spec_hash: 'abc', version_label: '1', spec_blob: {} },
    run: { started_at: '2026-10-12T00:00:00Z', finished_at: '2026-10-12T00:05:00Z', battery_hash: 'h', llm_model: null, llm_input_tokens: 0, llm_output_tokens: 0, trials: 2 },
    trials: [
      { ref: 1, endpoint: 'GET /v1/x', mutation_type: 'baseline', mutation_id: 'baseline', param: null, status: 200, signature: { status: 200, bodyKind: 'json', shape: { a: 'string' }, errorMessage: null, transportError: null }, input_hash: 'i1' },
      { ref: 2, endpoint: 'GET /v1/x', mutation_type: 'extra_field', mutation_id: 'extra_field', param: null, status: 400, signature: { status: 400, bodyKind: 'json', shape: { e: 'string' }, errorMessage: '[omitted in contribution]', transportError: null }, input_hash: 'i2' },
    ],
    claims: [
      { claim_key: 'rule:extra_field:get_v1_x:-', statement: 'Unknown query parameters are rejected with HTTP 400.', endpoint: 'GET /v1/x', kind: 'undocumented', param: null, verdict: 'rejects', source: 'rules', confidence: 0.9, divergence_type: null, spec_says: null, evidence: [1, 2], expectations: [{ trial_id: 1, status: 200 }, { trial_id: 2, status: 400 }] },
      { claim_key: 'llm:other:get_v1_x:-:observes:baseline', statement: 'Owner email is admin@corp.example in the body.', endpoint: 'GET /v1/x', kind: 'other', param: null, verdict: 'observes', source: 'llm', confidence: 0.5, divergence_type: null, spec_says: null, evidence: [1], expectations: [{ trial_id: 1, status: 200 }] },
    ],
    ...over,
  };
}

test('scrubBundle drops only the offending claims and reports why', () => {
  const { clean, rejected } = scrubBundle(bundle());
  assert.equal(clean.claims.length, 1);
  assert.equal(clean.claims[0].claim_key, 'rule:extra_field:get_v1_x:-');
  assert.deepEqual(rejected.map((r) => r.claim_key), ['llm:other:get_v1_x:-:observes:baseline']);
  assert.match(rejected[0].reason, /email/);
});

test('bundleProblem rejects wrong formats, smuggled inputs or bodies, and dangling evidence', () => {
  assert.equal(bundleProblem(bundle()), null);
  assert.match(bundleProblem({ ...bundle(), format: 'autopia-contribution/0' })!, /format/);
  assert.match(bundleProblem(bundle({ trials: [{ ...bundle().trials[0], input: { url: 'x' } } as never, bundle().trials[1]] }))!, /must not carry inputs/);
  assert.match(bundleProblem(bundle({ trials: [{ ...bundle().trials[0], body: '{}' } as never, bundle().trials[1]] }))!, /must not carry/);
  assert.match(bundleProblem(bundle({ claims: [{ ...bundle().claims[0], evidence: [1, 99] }] }))!, /cites evidence not in the bundle/);
  assert.match(bundleProblem(bundle({ tool: { ...bundle().tool, name: 'bad name' } }))!, /slug/);
  assert.match(bundleProblem('nope')!, /not an object/);
});
