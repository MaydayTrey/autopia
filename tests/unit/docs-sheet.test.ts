import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseDivergences, commonAcrossEndpoints, formatEvidence } from '../../src/db/docs.js';
import type { ClaimView } from '../../src/db/queries.js';

let n = 1;
function claim(p: { rule?: string; endpoint: string; param?: string | null; verdict?: string; status?: number; source?: 'rules' | 'llm'; statement?: string; spec_says?: string | null; kind?: string; evidenceCount?: number }): ClaimView {
  const id = n++;
  const source = p.source ?? 'rules';
  const key = source === 'rules' ? `rule:${p.rule ?? 'x'}:${p.endpoint.toLowerCase().replace(/[^a-z0-9]+/g, '_')}:${p.param ?? '-'}` : `llm:${p.kind ?? 'undocumented'}:${p.endpoint}:${p.param ?? '-'}:${p.verdict ?? 'observes'}:probe`;
  const base = { id: 1000, mutation_id: 'baseline', param: null, request: { method: 'GET', url: 'http://x', query: [] as [string, string][], headers: {} }, status: 200, error: null, latency_ms: 1, response_preview: null };
  const probes = Array.from({ length: p.evidenceCount ?? 1 }, (_, i) => ({ ...base, id: id * 100 + i, mutation_id: `${p.rule}:${p.param}`, param: p.param ?? null, status: p.status ?? 200 }));
  return {
    id,
    claim_key: key,
    statement: p.statement ?? `statement ${id}`,
    endpoint: p.endpoint,
    kind: p.kind ?? 'type',
    param: p.param ?? null,
    verdict: p.verdict ?? 'accepts',
    source,
    confidence: 0.9,
    diverges_from_spec: true,
    divergence_type: 'spec',
    spec_says: p.spec_says === undefined ? 'type: integer' : p.spec_says,
    sibling_note: null,
    verified: true,
    verified_by: 'server',
    verified_at: new Date('2026-10-12T00:00:00Z'),
    evidence: [base, ...probes],
  };
}

test('collapseDivergences: one family across params and endpoints becomes one line; lone and LLM divergences keep theirs', () => {
  const eps = ['GET /repos/{owner}/{repo}/commits', 'GET /repos/{owner}/{repo}/issues', 'GET /search/repositories'];
  const spec = [
    ...eps.flatMap((endpoint) => [claim({ rule: 'wrong_type', endpoint, param: 'per_page' }), claim({ rule: 'wrong_type', endpoint, param: 'page' })]),
    claim({ rule: 'enum_invalid', endpoint: eps[1], param: 'sort', spec_says: 'enum of 3 values' }),
    claim({ rule: 'enum_invalid', endpoint: eps[2], param: 'order', spec_says: 'enum of 2 values' }),
    claim({ rule: 'boundary_above_max', endpoint: eps[2], param: 'per_page', spec_says: 'maximum 100' }), // alone in its family: own line
    claim({ source: 'llm', endpoint: eps[0], param: 'sha', statement: 'sha accepts a branch name although documented as a commit SHA.', spec_says: 'format: sha' }),
  ];
  const lines = collapseDivergences(spec);
  assert.equal(lines.length, 4, 'types (6 claims) + enums (2 claims) + lone max + LLM');
  const types = lines.find((l) => /Declared types are not enforced/.test(l.line))!;
  assert.equal(types.claims.length, 6);
  assert.match(types.line, /^- \*\*One pattern, 6 claims\*\* Declared types are not enforced: "page", "per_page" accept a wrong-type value \("abc"\) with HTTP 200\. On 3 endpoints: GET \/repos\/\{owner\}\/\{repo\}\/commits, GET \/repos\/\{owner\}\/\{repo\}\/issues, GET \/search\/repositories\. Spec says: type: integer\. \[#/);
  const enums = lines.find((l) => /Documented enums are not enforced/.test(l.line))!;
  assert.match(enums.line, /"order", "sort" accept values outside their enum with HTTP 200\. On 2 endpoints: .* Spec says: enum of 3 values; enum of 2 values\./);
  assert.ok(lines.some((l) => /^- \*\*GET \/search\/repositories\*\* statement \d+ Spec says: maximum 100\./.test(l.line)), 'the lone maximum claim keeps its own line');
  assert.ok(lines.some((l) => /^- \*\*GET \/repos\/\{owner\}\/\{repo\}\/commits\*\* sha accepts a branch name/.test(l.line)), 'LLM divergences are never collapsed');
});

test('formatEvidence: at most 8 ids inline, then a count', () => {
  const c = claim({ rule: 'wrong_type', endpoint: 'GET /x', param: 'a', evidenceCount: 11 }); // baseline + 11 probes = 12 ids
  const s = formatEvidence(c);
  assert.match(s, /^\[#1000, (#\d+, ){6}#\d+, \+4 more\]$/);
  assert.equal(formatEvidence(claim({ rule: 'wrong_type', endpoint: 'GET /x', param: 'a', evidenceCount: 2 })).split('#').length - 1, 3);
});

test('commonAcrossEndpoints: a rule holding on every endpoint, or on all but one of 3+, is presented once; fewer stays per endpoint', () => {
  const eps = ['GET /a', 'GET /b', 'GET /c', 'GET /d'];
  const everywhere = eps.map((endpoint) => ({ ...claim({ rule: 'extra_field', endpoint, param: null, verdict: 'observes', kind: 'undocumented', statement: 'Unknown query parameters are ignored (HTTP 200).' }), divergence_type: null, diverges_from_spec: false }));
  const allButOne = eps.slice(0, 3).map((endpoint) => ({ ...claim({ rule: 'shape_timestamps', endpoint, param: null, verdict: 'observes', kind: 'response_shape', statement: 'Timestamps in successful responses are ISO 8601 with a Z suffix (e.g. 2026-09-21T16:24:00Z). Times are UTC.' }), divergence_type: null, diverges_from_spec: false }));
  const half = eps.slice(0, 2).map((endpoint) => ({ ...claim({ rule: 'method_head', endpoint, param: null, verdict: 'observes', kind: 'undocumented', statement: 'HEAD with the baseline query returns HTTP 200.' }), divergence_type: null, diverges_from_spec: false }));
  const common = commonAcrossEndpoints([...everywhere, ...allButOne, ...half], eps);
  assert.deepEqual(
    common.map((g) => [g.statement.slice(0, 20), g.claims.length, g.except ?? null]).sort(),
    [
      ['Timestamps in succes', 3, 'GET /d'],
      ['Unknown query parame', 4, null],
    ],
  );
});
