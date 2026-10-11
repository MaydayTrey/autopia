import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson, extractEndpoints, hashSpec, parseSpecText, SpecError } from '../../src/worker/spec.js';

const doc = {
  openapi: '3.1.0',
  info: { title: 'T', version: '1.2' },
  servers: [{ url: 'https://api.example.com/' }],
  components: {
    parameters: { Limit: { name: 'limit', in: 'query', schema: { $ref: '#/components/schemas/Limit' } } },
    schemas: { Limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 } },
    securitySchemes: {
      key: { type: 'apiKey', name: 'X-Api-Key', in: 'header' },
      ua: { type: 'apiKey', name: 'User-Agent', in: 'header' },
      q: { type: 'apiKey', name: 'api_key', in: 'query' },
      bearer: { type: 'http', scheme: 'bearer' }, // out of v1 scope: ignored
    },
  },
  paths: {
    '/things': {
      parameters: [{ name: 'tenant', in: 'header', required: true, schema: { type: 'string' } }],
      get: {
        operationId: 'listThings',
        parameters: [
          { name: 'q', in: 'query', required: true, schema: { type: ['string', 'null'] }, example: 'hello' },
          { $ref: '#/components/parameters/Limit' },
          { name: 'tags', in: 'query', explode: false, schema: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
        ],
      },
      post: { requestBody: {} },
    },
    '/things/{id}': {
      servers: [{ url: 'https://other.example.com' }],
      get: { parameters: [{ name: 'id', in: 'path', schema: { type: 'integer' } }], security: [{ key: [] }, { ua: [], q: [] }, { bearer: [] }] },
    },
    '/upload': { get: { requestBody: { content: {} } } },
  },
};

test('extractEndpoints: GET endpoints, $ref resolution, merged path-level params, servers, security', () => {
  const parsed = extractEndpoints(doc);
  assert.equal(parsed.title, 'T');
  assert.equal(parsed.version, '1.2');
  assert.deepEqual(parsed.endpoints.map((e) => e.path), ['/things', '/things/{id}']); // /upload skipped (requestBody), POST skipped

  const things = parsed.endpoints[0];
  assert.equal(things.server, 'https://api.example.com'); // trailing slash stripped
  assert.equal(things.hasSecurity, false);
  const byName = Object.fromEntries(things.params.map((p) => [p.name, p]));
  assert.equal(byName.tenant.in, 'header');
  assert.equal(byName.tenant.required, true);
  assert.equal(byName.q.type, 'string'); // ["string","null"] -> string
  assert.equal(byName.q.example, 'hello');
  assert.equal(byName.limit.type, 'integer');
  assert.equal(byName.limit.minimum, 1);
  assert.equal(byName.limit.maximum, 50);
  assert.equal(byName.limit.default, 10);
  assert.equal(byName.tags.type, 'array');
  assert.equal(byName.tags.itemType, 'string');
  assert.deepEqual(byName.tags.enum, ['a', 'b']);
  assert.equal(byName.tags.explode, false);

  const one = parsed.endpoints[1];
  assert.equal(one.server, 'https://other.example.com'); // path-level servers win
  assert.equal(one.hasSecurity, true);
  assert.equal(one.params[0].in, 'path');
  assert.equal(one.params[0].required, true); // path params are always required
  // apiKey schemes resolved to concrete header/query names; http bearer ignored; de-duplicated
  assert.deepEqual(one.authSchemes, [
    { scheme: 'key', name: 'X-Api-Key', in: 'header' },
    { scheme: 'ua', name: 'User-Agent', in: 'header' },
    { scheme: 'q', name: 'api_key', in: 'query' },
  ]);
  assert.deepEqual(things.authSchemes, []); // no root security, none on the op
});

test('extractEndpoints: rejects Swagger 2, non-OpenAPI, missing servers, no GET', () => {
  assert.throws(() => extractEndpoints({ swagger: '2.0', paths: {} }), SpecError);
  assert.throws(() => extractEndpoints({ hello: 1 }), SpecError);
  assert.throws(() => extractEndpoints({ openapi: '3.0.0', paths: { '/x': { get: {} } } }), /server URL/);
  assert.throws(() => extractEndpoints({ openapi: '3.0.0', servers: [{ url: 'https://a' }], paths: { '/x': { post: {} } } }), /no GET/);
});

test('parseSpecText handles YAML and JSON', () => {
  assert.deepEqual(parseSpecText('a: 1\nb: [x, y]'), { a: 1, b: ['x', 'y'] });
  assert.deepEqual(parseSpecText('{"a":1}'), { a: 1 });
  assert.throws(() => parseSpecText('a: [unclosed'), SpecError);
});

test('canonicalJson and hashSpec ignore key order', () => {
  const a = { b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } };
  const b = { a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(hashSpec(a), hashSpec(b));
  assert.notEqual(hashSpec(a), hashSpec({ ...a, b: 2 }));
});
