import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, comparisonTrial, llmClaims, SYSTEM_PROMPT } from '../../src/worker/aggregate/llm.js';
import { FakeLlm } from '../../src/llm/adapter.js';
import { ERR, OK_LIST, fakeTrial, itemsEndpoint, resetIds } from '../helpers.js';

function trials() {
  resetIds();
  const q: [string, string][] = [['q', 'hello']];
  return [
    fakeTrial({ mutationId: 'baseline', status: 200, body: OK_LIST, query: q }), // 1
    fakeTrial({ mutationId: 'required_omitted:q', status: 200, body: OK_LIST, query: [] }), // 2
    fakeTrial({ mutationId: 'optional_present:limit', status: 200, body: OK_LIST, query: [...q, ['limit', '1']] }), // 3
    fakeTrial({ mutationId: 'wrong_type:limit', status: 200, body: OK_LIST, query: [...q, ['limit', 'abc']] }), // 4
    fakeTrial({ mutationId: 'empty_value:q', status: 400, body: ERR('invalid_q', 'q required'), query: [['q', '']] }), // 5
    fakeTrial({ mutationId: 'extra_field', status: 200, body: OK_LIST, query: [...q, ['x', '1']] }), // 6
  ];
}

test('comparisonTrial: baseline for required/endpoint probes, optional_present for optional-param probes', () => {
  const ts = trials();
  const by = new Map(ts.map((t) => [t.mutationId, t]));
  const optional = new Set(['limit', 'page', 'sort', 'api_key']);
  const base = ts[0];
  assert.equal(comparisonTrial(ts[0], base, optional, by), undefined);
  assert.equal(comparisonTrial(ts[1], base, optional, by)?.id, 1);
  assert.equal(comparisonTrial(ts[2], base, optional, by)?.id, 1); // optional_present compares to baseline
  assert.equal(comparisonTrial(ts[3], base, optional, by)?.id, 3); // probe on optional param -> optional_present
  assert.equal(comparisonTrial(ts[4], base, optional, by)?.id, 1);
  assert.equal(comparisonTrial(ts[5], base, optional, by)?.id, 1);
});

test('buildSummary: documents params, lists trials with compare_to, includes known claims', () => {
  const s = buildSummary(trials(), [itemsEndpoint], [{ claim_key: 'k', statement: 'KNOWN STATEMENT', endpoint: 'GET /v1/items', kind: 'other', param: null, verdict: 'observes', source: 'rules', confidence: 0.9, evidence_trial_ids: [1], expectations: [{ trial_id: 1, status: 200 }], diverges_from_spec: false, spec_says: null }]);
  assert.match(s, /## GET \/v1\/items/);
  assert.match(s, /- q \| query \| required \| string/);
  assert.match(s, /- limit \| query \| optional \| integer \| min=1 max=100/);
  assert.match(s, /compare_to/);
  assert.match(s, /- 1 \| baseline \| - \| - \| q=hello \| 200 \| json keys: items,page,total/);
  assert.match(s, /- 4 \| wrong_type:limit \| limit \| #3 \| q=hello&limit=abc \| 200/);
  assert.match(s, /- 5 \| empty_value:q \| q \| #1 \| q= \| 400 \| error: "q required"/);
  assert.match(s, /Already claimed by rules[\s\S]*KNOWN STATEMENT/);
});

test('system prompt states the contract: comparison trials, undocumented_constraint, strict divergence', () => {
  assert.match(SYSTEM_PROMPT, /compare_to/);
  assert.match(SYSTEM_PROMPT, /undocumented_constraint/);
  assert.match(SYSTEM_PROMPT, /Silence in the spec is never a divergence/);
});

test('llmClaims: accepts undocumented_constraint claims, drops schema-invalid and unknown-evidence ones', async () => {
  const ts = trials();
  const fake = new FakeLlm([
    JSON.stringify({
      claims: [
        { statement: 'limit must accompany q; sending q alone changes nothing but limit=abc is tolerated (200).', endpoint: 'GET /v1/items', kind: 'undocumented_constraint', param: 'limit', verdict: 'accepts', evidence: [{ trial_id: 3, status: 200 }, { trial_id: 4, status: 200 }], confidence: 0.7, diverges_from_spec: false, spec_says: null },
        { statement: 'This cites a trial that is not in the table at all.', endpoint: 'GET /v1/items', kind: 'other', param: null, verdict: 'observes', evidence: [{ trial_id: 42, status: 200 }], confidence: 0.5, diverges_from_spec: false, spec_says: null },
        { statement: 'bad kind', endpoint: 'GET /v1/items', kind: 'made_up', param: null, verdict: 'observes', evidence: [{ trial_id: 1, status: 200 }], confidence: 0.5, diverges_from_spec: false, spec_says: null },
      ],
    }),
  ]);
  const r = await llmClaims(fake, ts, [itemsEndpoint], []);
  assert.equal(r.claims.length, 1);
  assert.equal(r.claims[0].kind, 'undocumented_constraint');
  assert.equal(r.claims[0].claim_key, 'llm:undocumented_constraint:get_v1_items:limit:accepts:optional_present:limit+wrong_type:limit');
  assert.equal(r.discarded.length, 2);
  assert.match(r.discarded[0].reason, /unknown trial ids 42/);
  assert.match(r.discarded[1].reason, /schema/);
  assert.equal(r.model, 'fake');
});

test('llmClaims: non-JSON and refusal produce no claims, never throw', async () => {
  const ts = trials();
  const r1 = await llmClaims(new FakeLlm(['not json at all']), ts, [itemsEndpoint], []);
  assert.equal(r1.claims.length, 0);
  assert.match(r1.discarded[0].reason, /not json/);
  const refusing = { name: 'refuse', complete: async () => ({ text: '', model: 'x', usage: { inputTokens: 1, outputTokens: 0 }, refused: true }) };
  const r2 = await llmClaims(refusing, ts, [itemsEndpoint], []);
  assert.equal(r2.claims.length, 0);
  assert.equal(r2.discarded[0].reason, 'refusal');
});
