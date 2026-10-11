import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, expandEnvInTarget, redactInput, restoreInput, secretsOf } from '../../src/worker/redact.js';
import { validateTarget } from '../../src/worker/target.js';
import type { TrialInput } from '../../src/worker/http.js';

const input: TrialInput = {
  method: 'GET',
  url: 'http://x/v1/items',
  query: [['q', 'hello'], ['api_key', 'sk-live-123'], ['token', 'abc'], ['limit', '5']],
  headers: { 'user-agent': 'autopia', 'x-api-key': 'real-key', authorization: 'Bearer t0k', accept: 'application/json', 'x-nothing': '' },
};

test('redactInput replaces credential VALUES by name, leaves everything else, keeps empty values empty', () => {
  const r = redactInput(input);
  assert.deepEqual(r.query, [['q', 'hello'], ['api_key', REDACTED], ['token', REDACTED], ['limit', '5']]);
  assert.equal(r.headers['x-api-key'], REDACTED);
  assert.equal(r.headers.authorization, REDACTED);
  assert.equal(r.headers['user-agent'], 'autopia');
  assert.equal(r.headers['x-nothing'], '', 'an explicit empty header stays empty (it means "send none")');
  assert.deepEqual(input.query[1], ['api_key', 'sk-live-123'], 'the original is not mutated');
  assert.ok(!JSON.stringify(r).includes('sk-live-123') && !JSON.stringify(r).includes('t0k') && !JSON.stringify(r).includes('real-key'));
});

test('secretsOf collects credentials from target headers and known-good values; restoreInput puts them back', () => {
  const target = validateTarget({ name: 't', spec_url: 'x', headers: { 'X-Api-Key': 'real-key', 'User-Agent': 'ua' }, baseline: { '/v1/items': { q: 'hello', api_key: 'sk-live-123' } }, optional_values: { '/v1/items': { token: 'abc' } } });
  const secrets = secretsOf(target);
  assert.deepEqual(secrets, { 'header:x-api-key': 'real-key', 'query:api_key': 'sk-live-123', 'query:token': 'abc' });
  const restored = restoreInput(redactInput(input), secrets);
  assert.deepEqual(restored.query, input.query);
  assert.equal(restored.headers['x-api-key'], 'real-key');
  assert.equal(restored.headers.authorization, REDACTED, 'a secret the target does not hold stays redacted and will fail honestly');
});

test('expandEnvInTarget resolves ${VAR} in header values and refuses unset ones', () => {
  const t = validateTarget({ name: 't', spec_url: 'x', headers: { 'x-api-key': '${MY_KEY}', 'user-agent': 'plain' } });
  const e = expandEnvInTarget(t, { MY_KEY: 'from-env' });
  assert.deepEqual(e.headers, { 'x-api-key': 'from-env', 'user-agent': 'plain' });
  assert.throws(() => expandEnvInTarget(t, {}), /references MY_KEY, which is not set/);
  // credentials as query parameters: baseline and optional values expand too
  const q = validateTarget({ name: 'q', spec_url: 'x', baseline: { '/v1': { api_key: '${K}', q: 'hello' } }, optional_values: { '/v1': { token: 'pre-${K}-post' } } });
  const eq = expandEnvInTarget(q, { K: 'val' });
  assert.deepEqual(eq.baseline, { '/v1': { api_key: 'val', q: 'hello' } });
  assert.deepEqual(eq.optional_values, { '/v1': { token: 'pre-val-post' } });
  assert.throws(() => expandEnvInTarget(q, {}), /baseline value "api_key" references K/);
});
