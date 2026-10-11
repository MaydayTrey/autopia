import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSignature, extractErrorMessage, shapeOf, signatureOf, signaturesEqual } from '../../src/worker/signature.js';

test('shapeOf describes structure, not values; keys sorted; arrays by first element', () => {
  assert.deepEqual(shapeOf({ b: 1, a: 'x', c: [1, 2, 3], d: null, e: [] }), { a: 'string', b: 'number', c: ['array', 'number'], d: 'null', e: ['array', 'empty'] });
  assert.deepEqual(shapeOf({ hourly: { time: ['2026-01-01'], temperature_2m: [1.5] } }), { hourly: { temperature_2m: ['array', 'number'], time: ['array', 'string'] } });
});

test('signatures of different live data with the same shape are equal', () => {
  const a = signatureOf({ status: 200, bodyKind: 'json', body: { temp: 11.2, time: 'now', hourly: [1, 2] } });
  const b = signatureOf({ status: 200, bodyKind: 'json', body: { time: 'later', temp: -3, hourly: [9] } });
  assert.ok(signaturesEqual(a, b));
  const c = signatureOf({ status: 200, bodyKind: 'json', body: { temp: 11.2 } });
  assert.ok(!signaturesEqual(a, c));
  const d = signatureOf({ status: 500, bodyKind: 'json', body: { temp: 11.2, time: 'now', hourly: [1, 2] } });
  assert.ok(!signaturesEqual(a, d));
});

test('error messages are extracted from common shapes and only compared on error statuses', () => {
  assert.equal(extractErrorMessage({ error: true, reason: 'Latitude must be in range' }), 'Latitude must be in range');
  assert.equal(extractErrorMessage({ error: { code: 'x', message: 'nested msg' } }), 'nested msg');
  assert.equal(extractErrorMessage({ errors: [{ message: 'first' }] }), 'first');
  assert.equal(extractErrorMessage('plain text error'), 'plain text error');
  assert.equal(extractErrorMessage({ items: [] }), null);
  const okSig = signatureOf({ status: 200, bodyKind: 'json', body: { message: 'hello' } });
  assert.equal(okSig.errorMessage, null);
  const errSig = signatureOf({ status: 400, bodyKind: 'json', body: { message: 'bad' } });
  assert.equal(errSig.errorMessage, 'bad');
});

test('describeSignature', () => {
  assert.equal(describeSignature(signatureOf({ status: 200, bodyKind: 'json', body: {} })), 'HTTP 200 JSON');
  assert.equal(describeSignature(signatureOf({ status: 400, bodyKind: 'json', body: { reason: 'nope' } })), 'HTTP 400 "nope"');
  assert.equal(describeSignature(signatureOf({ status: null, bodyKind: 'none', body: null, transportError: 'timeout' })), 'transport error (timeout)');
  assert.equal(describeSignature(signatureOf({ status: 404, bodyKind: 'text', body: 'not found' })), 'HTTP 404 "not found"');
});
