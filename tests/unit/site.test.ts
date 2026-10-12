import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointSlug, escapeHtml, extractErrors, mdToHtml, page } from '../../src/site/build.js';
import type { ClaimView } from '../../src/db/queries.js';

test('endpointSlug: file-safe, template braces dropped', () => {
  assert.equal(endpointSlug('GET /repos/{owner}/{repo}/issues'), 'get-repos-owner-repo-issues');
  assert.equal(endpointSlug('GET /-/v1/search'), 'get-v1-search');
  assert.equal(endpointSlug('GET /rate_limit'), 'get-rate-limit');
});

test('mdToHtml: headings with ids, bullet lists, paragraphs, text escaped; inline markup left as text', () => {
  const html = mdToHtml('# T\n\nSome <b>text</b> & more.\n\n## Where behavior contradicts the spec (2)\n- **GET /x** a < b [#1]\n- second\n\n### GET /v1/items\nline');
  assert.match(html, /^<h1 id="t">T<\/h1>/);
  assert.match(html, /<p>Some &lt;b&gt;text&lt;\/b&gt; &amp; more\.<\/p>/);
  assert.match(html, /<h2 id="where-behavior-contradicts-the-spec-2">Where behavior contradicts the spec \(2\)<\/h2>\n<ul>\n<li>\*\*GET \/x\*\* a &lt; b \[#1\]<\/li>\n<li>second<\/li>\n<\/ul>/);
  assert.match(html, /<h3 id="get-v1-items">GET \/v1\/items<\/h3>\n<p>line<\/p>$/);
  assert.equal(escapeHtml('"a" & <b>'), '&quot;a&quot; &amp; &lt;b&gt;');
});

test('page: title, description, robots, links to the text twin and the live call', () => {
  const html = page('github-rest: verified API behavior', 'desc "quoted"', '<p>x</p>', { md: 'index.md', live: 'get_tool_docs {"tool":"github-rest"}' });
  assert.match(html, /<title>github-rest: verified API behavior<\/title>/);
  assert.match(html, /<meta name="description" content="desc &quot;quoted&quot;">/);
  assert.match(html, /<meta name="robots" content="index,follow">/);
  assert.match(html, /<a href="index.md">plain text \(\.md\)<\/a> · live: <code>get_tool_docs \{&quot;tool&quot;:&quot;github-rest&quot;\}<\/code>/);
});

test('extractErrors: every quoted "HTTP nnn \\"message\\"" in a statement becomes an indexed row with host, endpoint and trials', () => {
  const claim = (statement: string, endpoint = 'GET /repos/{owner}/{repo}/issues'): ClaimView =>
    ({ id: 1, claim_key: 'k', statement, endpoint, kind: 'type', param: null, verdict: 'rejects', source: 'rules', confidence: 0.9, diverges_from_spec: false, divergence_type: null, spec_says: null, sibling_note: null, verified: true, verified_by: 'server', verified_at: new Date(), evidence: [{ id: 10 } as never, { id: 11 } as never] }) as ClaimView;
  const rows = extractErrors('github-rest', ['api.github.com'], [
    claim('Date parameter "since" rejects a Unix epoch value (1768478400) with HTTP 422 "The since parameter needs to be in ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ".'),
    claim('Pagination parameter "page" = 100000 or 999999999 is rejected with HTTP 422 "Only the first 10000 results are available.".', 'GET /repos/{owner}/{repo}/releases'),
    claim('Unknown query parameters are ignored (HTTP 200).'),
  ]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { message: 'The since parameter needs to be in ISO 8601 format: YYYY-MM-DDTHH:MM:SSZ', host: 'api.github.com', tool: 'github-rest', endpoint: 'GET /repos/{owner}/{repo}/issues', status: 422, statement: rows[0].statement, trialIds: [10, 11] });
  assert.equal(rows[1].endpoint, 'GET /repos/{owner}/{repo}/releases');
  assert.equal(rows[1].message, 'Only the first 10000 results are available.');
});
