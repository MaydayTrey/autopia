import { test } from 'node:test';
import assert from 'node:assert/strict';
// The plugin runs on plain Node from its own directory, so its helpers are .mjs, not TypeScript.
// @ts-expect-error untyped JS module shipped inside the plugin
import { buildContext, buildErrorContext, candidateText, detectFailure, hookOutput, hostIndex, matchHosts, parseMcpBody, resultText, setupContext, sheetEndpoint, trimSheet, urlPathFor } from '../../plugin/scripts/lib.mjs';

const INDEX = hostIndex([
  { name: 'github-rest', hosts: ['api.github.com'] },
  { name: 'open-meteo-forecast', hosts: ['api.open-meteo.com'] },
  { name: 'open-meteo-elevation', hosts: ['api.open-meteo.com'] },
  { name: 'mock-items', hosts: ['127.0.0.1:4321'] },
  { name: 'jikan', hosts: [] },
]);

test('hostIndex: host -> tools, several tools may share a host, hostless tools are left out', () => {
  assert.deepEqual(INDEX, {
    'api.github.com': ['github-rest'],
    'api.open-meteo.com': ['open-meteo-forecast', 'open-meteo-elevation'],
    '127.0.0.1:4321': ['mock-items'],
  });
});

test('candidateText: Bash command and WebFetch url are scanned; other tools and malformed input are not', () => {
  assert.equal(candidateText('Bash', { command: 'curl https://api.github.com/x' }), 'curl https://api.github.com/x');
  assert.equal(candidateText('WebFetch', { url: 'https://pypi.org/pypi/requests/json', prompt: 'x' }), 'https://pypi.org/pypi/requests/json');
  assert.equal(candidateText('Read', { file_path: 'api.github.com' }), null);
  assert.equal(candidateText('Bash', null), null);
  assert.equal(candidateText('Bash', { command: 42 }), null);
});

test('matchHosts: URL-shaped mentions only (scheme, or host followed by a path); bare mentions and JSON arguments do not fire', () => {
  assert.deepEqual(matchHosts('curl -s https://api.github.com/repos/x/y', INDEX), [{ host: 'api.github.com', tools: ['github-rest'] }]);
  assert.deepEqual(matchHosts('curl https://api.github.com', INDEX), [{ host: 'api.github.com', tools: ['github-rest'] }], 'scheme without a path');
  assert.deepEqual(matchHosts('curl API.GitHub.com/rate_limit', INDEX), [{ host: 'api.github.com', tools: ['github-rest'] }]);
  assert.deepEqual(matchHosts(`curl -X POST https://autopia-mcp.onrender.com/mcp -d '{"name":"get_tool_docs","arguments":{"tool":"api.github.com"}}'`, INDEX), [], 'a host inside a JSON argument is not a call to it');
  assert.deepEqual(matchHosts('echo api.github.com', INDEX), []);
  assert.deepEqual(matchHosts('git commit -m "handle api.github.com rate limits"', INDEX), []);
  assert.deepEqual(matchHosts('curl user@api.github.com/x', INDEX), [], 'userinfo-style token is not a host');
  assert.deepEqual(matchHosts(`fetch("https://api.open-meteo.com/v1/forecast")`, INDEX), [{ host: 'api.open-meteo.com', tools: ['open-meteo-forecast', 'open-meteo-elevation'] }]);
  assert.deepEqual(matchHosts('curl http://127.0.0.1:4321/v1/items', INDEX), [{ host: '127.0.0.1:4321', tools: ['mock-items'] }]);
  assert.deepEqual(matchHosts('curl https://notapi.github.com/x', INDEX), []);
  assert.deepEqual(matchHosts('curl https://api.github.community/x', INDEX), []);
  assert.deepEqual(matchHosts('curl http://127.0.0.1:43210/v1/items', INDEX), [], 'a port is part of the host');
  assert.deepEqual(matchHosts('git status', INDEX), []);
  assert.deepEqual(matchHosts('', INDEX), []);
});

test('parseMcpBody + resultText: JSON and SSE bodies; rpc errors and isError results throw', () => {
  const ok = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '# sheet' }] } };
  assert.equal(resultText(parseMcpBody('application/json', JSON.stringify(ok))), '# sheet');
  const sse = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'first' }] } })}\n\nevent: message\ndata: ${JSON.stringify(ok)}\n\n`;
  assert.equal(resultText(parseMcpBody('text/event-stream', sse)), '# sheet');
  assert.throws(() => resultText({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }), /rpc error -32602: bad params/);
  assert.throws(() => resultText({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: '{"error":"no such tool: x"}' }] } }), /no such tool/);
  assert.throws(() => parseMcpBody('text/event-stream', 'event: ping\n\n'), /empty event stream/);
});

test('trimSheet: cuts at a line boundary under the budget and points at get_tool_docs', () => {
  const md = Array.from({ length: 200 }, (_, i) => `- line ${i} of the sheet with some words in it`).join('\n');
  const out = trimSheet(md, 2000, 'github-rest');
  assert.ok(out.length <= 2000, `length ${out.length}`);
  assert.match(out, /\n\n\[Sheet truncated at 2000 characters\. Full sheet: get_tool_docs \{"tool":"github-rest"\}/);
  assert.ok(!/line \d+ of the sheet with some words in it[^\n]+\n\n\[Sheet/.test(out), 'no half line before the note');
  assert.equal(trimSheet('short', 2000, 'x'), 'short');
  // A nearby section heading wins over a mid-section line, so no endpoint is shown half-way.
  const line = (p: string, i: number) => `- ${p} line ${i} with enough words in it to count`;
  const sections = ['# tool', '## Common', ...Array.from({ length: 20 }, (_, i) => line('common', i)), '### GET /a', ...Array.from({ length: 20 }, (_, i) => line('a', i)), '### GET /b', ...Array.from({ length: 20 }, (_, i) => line('b', i))].join('\n');
  const atSection = trimSheet(sections, 2300, 't');
  assert.match(atSection, /- a line 19 with enough words in it to count\n\n\[Sheet truncated/, 'cut lands right before the ### GET /b heading');
  assert.doesNotMatch(atSection, /### GET \/b/);
});

test('buildContext: header + one block per sheet, budget split between tools on the same host, stays near 5KB', () => {
  const big = '# x\n' + 'y'.repeat(20_000);
  const ctx = buildContext([
    { host: 'api.open-meteo.com', tool: 'open-meteo-forecast', markdown: big },
    { host: 'api.open-meteo.com', tool: 'open-meteo-elevation', markdown: big },
  ]);
  assert.ok(ctx.length < 5_100, `length ${ctx.length}`);
  assert.match(ctx, /^Autopia: VERIFIED behavior/);
  assert.match(ctx, /--- api\.open-meteo\.com -> open-meteo-forecast ---/);
  assert.match(ctx, /--- api\.open-meteo\.com -> open-meteo-elevation ---/);
  assert.equal(buildContext([]), '');
});

test('urlPathFor: the request path used with a host, without query or trailing slash; null for a bare host', () => {
  assert.equal(urlPathFor('curl -s "https://api.github.com/repos/x/y/issues?per_page=5"', 'api.github.com'), '/repos/x/y/issues');
  assert.equal(urlPathFor('curl api.github.com/rate_limit/', 'api.github.com'), '/rate_limit');
  assert.equal(urlPathFor('curl https://api.github.com', 'api.github.com'), null);
  assert.equal(urlPathFor('curl http://127.0.0.1:4321/v1/items?q=a', '127.0.0.1:4321'), '/v1/items');
  assert.equal(urlPathFor(`fetch('https://api.open-meteo.com/v1/forecast')`, 'api.open-meteo.com'), '/v1/forecast');
});

test('sheetEndpoint: the endpoint a scoped sheet is about, from its title', () => {
  assert.equal(sheetEndpoint('# github-rest: verified behavior for GET /repos/{owner}/{repo}/issues\n\nSpec: x'), 'GET /repos/{owner}/{repo}/issues');
  assert.equal(sheetEndpoint('# github-rest: verified behavior\n\nSpec: x'), null);
});

test('setupContext and hookOutput shapes', () => {
  const s = setupContext([{ host: 'api.github.com', tools: ['github-rest'] }]);
  assert.match(s, /calls api\.github\.com/);
  assert.match(s, /claude plugin configure autopia/);
  assert.deepEqual(hookOutput('ctx'), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' } });
});

test('detectFailure: a 4xx/5xx from a covered host, from a status line or a JSON status/message; nothing for 2xx, unknown hosts or non-calls', () => {
  const cmd = { command: 'curl -s -i https://api.github.com/repos/github/rest-api-description/issues?issue_field_values=test' };
  const f = detectFailure('Bash', cmd, { stdout: 'HTTP/2 422\ncontent-type: application/json\n\n{"message":"Validation Failed","documentation_url":"https://docs.github.com","status":"422"}', stderr: '' }, INDEX);
  assert.deepEqual(f, { host: 'api.github.com', tools: ['github-rest'], path: '/repos/github/rest-api-description/issues', status: 422, message: 'Validation Failed' });
  // No status line (curl -s), GitHub-style body carries the status.
  const g = detectFailure('Bash', cmd, '{"message":"Not Found","documentation_url":"x","status":"404"}', INDEX);
  assert.equal(g!.status, 404);
  assert.equal(g!.message, 'Not Found');
  // A nested error object with a message and no status at all: assumed 400 because the body says error.
  const h = detectFailure('Bash', { command: 'curl http://127.0.0.1:4321/v1/items?limit=0' }, '{"error":{"code":"invalid_limit","message":"limit must be >= 1"}}', INDEX);
  assert.deepEqual(h, { host: '127.0.0.1:4321', tools: ['mock-items'], path: '/v1/items', status: 400, message: 'limit must be >= 1' });
  // Success, unknown host, or a command that is not a call: nothing.
  assert.equal(detectFailure('Bash', cmd, 'HTTP/2 200\n\n[{"id":1}]', INDEX), null);
  assert.equal(detectFailure('Bash', { command: 'curl -i https://example.com/x' }, 'HTTP/1.1 500', INDEX), null);
  assert.equal(detectFailure('Bash', { command: 'echo api.github.com' }, 'HTTP/1.1 500', INDEX), null);
  assert.equal(detectFailure('Bash', cmd, '', INDEX), null);
  // WebFetch: the url is the call; the response is text.
  const w = detectFailure('WebFetch', { url: 'https://api.github.com/users/nobody-here-xyz', prompt: 'x' }, 'Request failed: {"message":"Not Found","status":"404"}', INDEX);
  assert.equal(w!.status, 404);
});

test('buildErrorContext: the failure, then compact matching claims within a budget, then how to dig further', () => {
  const failure = { host: 'api.github.com', tools: ['github-rest'], path: '/repos/x/y/issues', status: 422, message: 'Validation Failed' };
  const claim = (i: number) => ({ endpoint: 'GET /repos/{owner}/{repo}/issues', statement: `claim ${i} ` + 'x'.repeat(300), evidence: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] });
  const ctx = buildErrorContext(failure, [claim(1), claim(2), claim(3), claim(4), claim(5), claim(6), claim(7), claim(8), claim(9), claim(10)]);
  assert.match(ctx, /^Autopia: the call to api\.github\.com\/repos\/x\/y\/issues failed with HTTP 422 "Validation Failed"\./);
  assert.match(ctx, /- \[GET \/repos\/\{owner\}\/\{repo\}\/issues\] claim 1 x+ \[#1, #2, #3\]/, 'three evidence ids');
  assert.ok(ctx.length <= 2700, `length ${ctx.length}`);
  assert.ok((ctx.match(/^- /gm) ?? []).length < 10, 'budget cut the list');
  assert.match(ctx, /search_claims \{"query":"<symptom>","tool":"api\.github\.com"\}/);
  assert.deepEqual(hookOutput('c', 'PostToolUse'), { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'c' } });
});
