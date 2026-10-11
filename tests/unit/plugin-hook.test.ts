import { test } from 'node:test';
import assert from 'node:assert/strict';
// The plugin runs on plain Node from its own directory, so its helpers are .mjs, not TypeScript.
// @ts-expect-error untyped JS module shipped inside the plugin
import { buildContext, candidateText, hookOutput, hostIndex, matchHosts, parseMcpBody, resultText, setupContext, trimSheet } from '../../plugin/scripts/lib.mjs';

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

test('matchHosts: whole-host matches in URLs, bare hosts and quoted strings; no substring false positives', () => {
  assert.deepEqual(matchHosts('curl -s https://api.github.com/repos/x/y', INDEX), [{ host: 'api.github.com', tools: ['github-rest'] }]);
  assert.deepEqual(matchHosts('curl API.GitHub.com/rate_limit', INDEX), [{ host: 'api.github.com', tools: ['github-rest'] }]);
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
});

test('buildContext: header + one block per sheet, budget split between tools on the same host, stays under 10,000 chars', () => {
  const big = '# x\n' + 'y'.repeat(20_000);
  const ctx = buildContext([
    { host: 'api.open-meteo.com', tool: 'open-meteo-forecast', markdown: big },
    { host: 'api.open-meteo.com', tool: 'open-meteo-elevation', markdown: big },
  ]);
  assert.ok(ctx.length < 10_000, `length ${ctx.length}`);
  assert.match(ctx, /^Autopia: VERIFIED behavior/);
  assert.match(ctx, /--- api\.open-meteo\.com -> open-meteo-forecast ---/);
  assert.match(ctx, /--- api\.open-meteo\.com -> open-meteo-elevation ---/);
  assert.equal(buildContext([]), '');
});

test('setupContext and hookOutput shapes', () => {
  const s = setupContext([{ host: 'api.github.com', tools: ['github-rest'] }]);
  assert.match(s, /calls api\.github\.com/);
  assert.match(s, /claude plugin configure autopia/);
  assert.deepEqual(hookOutput('ctx'), { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'ctx' } });
});
