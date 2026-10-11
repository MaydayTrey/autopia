import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf } from '../../src/db/queries.js';

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
