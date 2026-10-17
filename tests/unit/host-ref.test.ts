import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTool, hostOf, matchEndpoint, pathOf, pickToolByPath } from '../../src/db/queries.js';

test('hostOf: what an agent passes as `tool` — a name stays a name; a host or URL yields the host (with port)', () => {
  // Plain tool names: not hosts.
  assert.equal(hostOf('github-rest'), null);
  assert.equal(hostOf('open-meteo-forecast'), null);
  assert.equal(hostOf('mock-items'), null);
  assert.equal(hostOf(''), null);
  // Bare hosts, with or without a path, case-insensitive.
  assert.equal(hostOf('api.github.com'), 'api.github.com');
  assert.equal(hostOf('API.GitHub.com/repos/github/rest-api-description'), 'api.github.com');
  assert.equal(hostOf('registry.npmjs.org/-/v1/search?text=express'), 'registry.npmjs.org');
  assert.equal(hostOf('127.0.0.1:4321/v1/items'), '127.0.0.1:4321');
  assert.equal(hostOf('localhost:3000'), 'localhost:3000');
  // Full URLs keep the port and drop path, query and fragment.
  assert.equal(hostOf('https://api.anthropic.com/v1/models?limit=5#x'), 'api.anthropic.com');
  assert.equal(hostOf('http://127.0.0.1:4321/v1/items'), '127.0.0.1:4321');
});

test('pickToolByPath: on a host shared by several tools, the request path picks the tool whose probed endpoints match it', () => {
  const byTool = new Map([
    ['open-meteo-elevation', ['GET /v1/elevation']],
    ['open-meteo-forecast', ['GET /v1/forecast']],
  ]);
  assert.equal(pickToolByPath('/v1/forecast', byTool), 'open-meteo-forecast');
  assert.equal(pickToolByPath('/v1/forecast/', byTool), 'open-meteo-forecast', 'trailing slash');
  assert.equal(pickToolByPath('/v1/elevation?latitude=1', byTool), 'open-meteo-elevation', 'query ignored');
  assert.equal(pickToolByPath(null, byTool), null, 'a bare host cannot choose');
  assert.equal(pickToolByPath('/v1/marine', byTool), null, 'an unprobed path cannot choose');
  // Two tools probing the same endpoint stay ambiguous.
  assert.equal(pickToolByPath('/v1/items', new Map([['a', ['GET /v1/items']], ['b', ['GET /v1/items']]])), null);
  // Template segments match anything; the most literal match wins.
  assert.equal(matchEndpoint('/repos/github/rest-api-description/issues', ['GET /repos/{owner}/{repo}/issues', 'GET /repos/{owner}/{repo}/commits']), 'GET /repos/{owner}/{repo}/issues');
  assert.equal(pathOf('https://api.open-meteo.com/v1/forecast?latitude=52'), '/v1/forecast');
});

test('canonicalTool: a base tool wins over its named variants; unrelated names stay ambiguous', () => {
  assert.equal(canonicalTool(['github-rest', 'github-rest-2026-03-10']), 'github-rest');
  assert.equal(canonicalTool(['github-rest-2026-03-10', 'github-rest']), 'github-rest');
  assert.equal(canonicalTool(['open-meteo-elevation', 'open-meteo-forecast']), null, 'siblings, not variants');
  assert.equal(canonicalTool(['a', 'ab']), null, 'a prefix without the dash is not a variant');
  assert.equal(canonicalTool(['only']), 'only');
});
