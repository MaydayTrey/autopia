import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_RE, generateKey, hashKey, prefixOf } from '../../src/db/keys.js';

test('generateKey: ak_ prefix, 40 base62 chars, unique, never repeats', () => {
  const keys = Array.from({ length: 200 }, () => generateKey());
  for (const k of keys) assert.match(k, KEY_RE);
  assert.equal(new Set(keys).size, keys.length);
});

test('hashKey is stable, 64 hex chars, and not the key itself', () => {
  const k = generateKey();
  assert.equal(hashKey(k), hashKey(k));
  assert.match(hashKey(k), /^[0-9a-f]{64}$/);
  assert.notEqual(hashKey(k), k);
  assert.notEqual(hashKey(k), hashKey(generateKey()));
});

test('prefixOf shows ak_ plus six characters, enough to identify, not enough to use', () => {
  const k = generateKey();
  assert.equal(prefixOf(k).length, 9);
  assert.ok(k.startsWith(prefixOf(k)));
  assert.ok(!KEY_RE.test(prefixOf(k)));
});
