import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderParameterLines, summarizeParameters } from '../../src/db/docs.js';
import type { ClaimView } from '../../src/db/queries.js';

let n = 1;
function view(p: { rule: string; param: string; verdict: 'accepts' | 'rejects' | 'observes'; status?: number; kind?: string; statement?: string }): ClaimView {
  const id = n++;
  const base = { id: 1000, mutation_id: 'baseline', param: null, request: { method: 'GET', url: 'http://x', query: [], headers: {} }, status: 200, error: null, latency_ms: 1, response_preview: null };
  const probe = { ...base, id, mutation_id: `${p.rule}:${p.param}`, param: p.param, status: p.status ?? (p.verdict === 'rejects' ? 400 : 200) };
  return {
    id,
    claim_key: `rule:${p.rule}:get_v1_items:${p.param}`,
    statement: p.statement ?? `${p.rule} on ${p.param} ${p.verdict}`,
    endpoint: 'GET /v1/items',
    kind: p.kind ?? 'type',
    param: p.param,
    verdict: p.verdict,
    source: 'rules',
    confidence: 0.9,
    diverges_from_spec: false,
    divergence_type: null,
    spec_says: null,
    sibling_note: null,
    verified: true,
    evidence: [base, probe],
  };
}

test('summarizeParameters groups probe claims per parameter by verdict with the probe status', () => {
  const s = summarizeParameters([
    view({ rule: 'wrong_type', param: 'limit', verdict: 'rejects' }),
    view({ rule: 'boundary_zero', param: 'limit', verdict: 'rejects' }),
    view({ rule: 'boundary_above_max', param: 'limit', verdict: 'accepts' }),
    view({ rule: 'empty_value', param: 'q', verdict: 'accepts', kind: 'undocumented' }),
    view({ rule: 'optional_present', param: 'q', verdict: 'rejects', kind: 'other', statement: 'q with value x is rejected' }),
  ]);
  assert.deepEqual(s.map((x) => x.param), ['limit', 'q']);
  assert.deepEqual(s[0].rejects.map((r) => r.label), ['a wrong-type value ("abc")', '0']);
  assert.deepEqual(s[0].accepts.map((r) => r.label), ['a value just above the documented maximum']);
  assert.equal(s[0].rejects[0].status, 400);
  assert.equal(s[1].accepts.length, 1);
  assert.equal(s[1].observes.length, 1, 'non-probe claims stay as observations');
});

test('renderParameterLines collapses to ONE line when every parameter rejects everything', () => {
  const claims = ['a', 'b', 'c'].flatMap((p) => ['wrong_type', 'null_value', 'empty_value', 'boundary_negative'].map((rule) => view({ rule, param: p, verdict: 'rejects' })));
  const lines = renderParameterLines(summarizeParameters(claims));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /All 3 probed parameters \(`a`, `b`, `c`\) reject every invalid value tried .* with HTTP 400/);
  assert.match(lines[0], /\[#\d+(, #\d+)+\]/, 'merged evidence');
});

test('renderParameterLines spells out only the parameters that behave differently', () => {
  const uniform = ['a', 'b', 'c'].flatMap((p) => ['wrong_type', 'null_value'].map((rule) => view({ rule, param: p, verdict: 'rejects' })));
  const odd = [view({ rule: 'wrong_type', param: 'limit', verdict: 'accepts' }), view({ rule: 'boundary_zero', param: 'limit', verdict: 'rejects' }), view({ rule: 'null_value', param: 'limit', verdict: 'rejects' })];
  const lines = renderParameterLines(summarizeParameters([...uniform, ...odd]));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- `a`, `b`, `c` reject every invalid value tried with HTTP 400/);
  assert.match(lines[1], /^- `limit` rejects 0, the literal "null" \(HTTP 400\) \[#\d+, #\d+, #\d+\]; but accepts a wrong-type value \("abc"\) \(HTTP 200\)/);
});

test('renderParameterLines dedupes probe-value variants into one clause per status', () => {
  const lines = renderParameterLines(
    summarizeParameters([
      view({ rule: 'boundary_zero', param: 'offset', verdict: 'rejects', status: 400 }),
      view({ rule: 'boundary_negative', param: 'offset', verdict: 'rejects', status: 400 }),
      view({ rule: 'boundary_max_int', param: 'offset', verdict: 'rejects', status: 422 }),
    ]),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`offset` rejects 0, -1 \(HTTP 400\) \[#\d+, #\d+, #\d+\]; 2147483648 \(HTTP 422\)/);
});


test('renderParameterLines lists a probe value once even when two rules sent it (boundary_zero and pagination_zero both send 0)', () => {
  const lines = renderParameterLines(
    summarizeParameters([
      view({ rule: 'boundary_zero', param: 'limit', verdict: 'rejects', status: 400 }),
      view({ rule: 'pagination_zero', param: 'limit', verdict: 'rejects', status: 400 }),
      view({ rule: 'boundary_negative', param: 'limit', verdict: 'rejects', status: 400 }),
    ]),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`limit` rejects 0, -1 \(HTTP 400\) \[#\d+, #\d+, #\d+, #\d+\]\.$/, 'label "0" appears once; baseline + all three probe claims still cited');
});

test('renderParameterLines shows the spec-relative boundary value that was actually sent', () => {
  const withQuery = (c: ClaimView, value: string): ClaimView => {
    const probe = c.evidence[c.evidence.length - 1];
    return { ...c, evidence: [c.evidence[0], { ...probe, request: { ...probe.request, query: [['limit', value]] } }] };
  };
  const lines = renderParameterLines(
    summarizeParameters([
      withQuery(view({ rule: 'boundary_above_max', param: 'limit', verdict: 'rejects', status: 400 }), '101'),
      withQuery(view({ rule: 'boundary_far_above_max', param: 'limit', verdict: 'rejects', status: 400 }), '100000'),
      view({ rule: 'boundary_below_min', param: 'limit', verdict: 'rejects', status: 400 }), // no value recorded: generic label
    ]),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`limit` rejects 101 \(just above the documented maximum\), 100000 \(far above the documented maximum\), a value below the documented minimum \(HTTP 400\)/);
});

test('renderParameterLines treats "0" and "0 (below the documented minimum)" as the same probe value', () => {
  const withQuery = (c: ClaimView, value: string): ClaimView => {
    const probe = c.evidence[c.evidence.length - 1];
    return { ...c, evidence: [c.evidence[0], { ...probe, request: { ...probe.request, query: [['limit', value]] } }] };
  };
  const lines = renderParameterLines(
    summarizeParameters([
      view({ rule: 'boundary_zero', param: 'limit', verdict: 'rejects', status: 400 }),
      withQuery(view({ rule: 'boundary_below_min', param: 'limit', verdict: 'rejects', status: 400 }), '0'),
      withQuery(view({ rule: 'boundary_above_max', param: 'limit', verdict: 'rejects', status: 400 }), '1001'),
    ]),
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /`limit` rejects 0, 1001 \(just above the documented maximum\) \(HTTP 400\)/);
});
