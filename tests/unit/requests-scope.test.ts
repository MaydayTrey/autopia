import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScope, publicHostProblem } from '../../src/db/requests.js';

test('publicHostProblem rejects private, local, literal-IP, and non-http hosts', () => {
  for (const bad of [
    'http://localhost/spec.json',
    'http://127.0.0.1:8080/openapi.json',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://172.16.0.1/x',
    'http://169.254.169.254/latest/meta-data', // cloud metadata
    'http://[::1]/x',
    'http://api.internal/x',
    'http://printer.local/x',
    'http://93.184.216.34/x',
    'ftp://example.com/x',
    'file:///etc/passwd',
    'http://user:pw@example.com/x',
    'http://intranet/x',
  ]) {
    assert.ok(publicHostProblem(bad), `should reject ${bad}`);
  }
  for (const ok of ['https://api.weather.gov/openapi.json', 'http://example.com/spec.yml', 'https://raw.githubusercontent.com/a/b/main/openapi.yml']) {
    assert.equal(publicHostProblem(ok), null, `should accept ${ok}`);
  }
});

test('checkScope: keyless only, public hosts, and caps we control', () => {
  assert.throws(() => checkScope({ name: 'x', spec_url: 'https://example.com/s.json', headers: { 'x-api-key': 'k' } }), /headers are not accepted/);
  assert.throws(() => checkScope({ name: 'x', spec_url: 'http://localhost/s.json' }), /spec_url: host "localhost"/);
  assert.throws(() => checkScope({ name: 'x', spec_url: 'https://example.com/s.json', server: 'http://10.1.1.1' }), /server: host/);
  assert.throws(() => checkScope({ name: 'bad name!', spec_url: 'https://example.com/s.json' }), /slug/);
  const t = checkScope({ name: 'x', spec_url: 'https://example.com/s.json', rate: { concurrency: 8, min_interval_ms: 0 }, max_trials: 5000, headers: {} });
  assert.deepEqual(t.rate, { concurrency: 1, min_interval_ms: 300 });
  assert.equal(t.max_trials, 300);
  assert.deepEqual(t.headers, {});
  const polite = checkScope({ name: 'y', spec_url: 'https://example.com/s.json', rate: { concurrency: 1, min_interval_ms: 900 }, max_trials: 50 });
  assert.equal(polite.rate?.min_interval_ms, 900, 'slower than our floor is kept');
  assert.equal(polite.max_trials, 50);
});
