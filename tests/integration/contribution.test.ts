/**
 * Contributor tier end to end:
 *   1. a "keyed" target (header from an env var) runs LOCALLY; stored trial
 *      inputs are redacted, and reproduction still works because verify
 *      restores the secret from the target
 *   2. the bundle built from that run carries no inputs, headers, bodies or
 *      error text, and the secret appears nowhere in it
 *   3. importing it into a SECOND database (the "server") creates a
 *      contributor-tier tool whose sheet says who verified it and when
 *   4. a server-verified tool cannot be overwritten by a contribution
 *   5. the real HTTP endpoint accepts the bundle with a key and refuses without
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { startMockApi, type MockApi } from '../mock-api/server.js';
import type { ContributionBundle } from '../../src/worker/contribute.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'super-secret-key-value-12345xyz';
let localDir: string;
let serverDir: string;
let api: MockApi;
let client: typeof import('../../src/db/client.js');
let bundle: ContributionBundle;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a !== 'string' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

before(async () => {
  localDir = await mkdtemp(path.join(os.tmpdir(), 'autopia-contrib-local-'));
  serverDir = await mkdtemp(path.join(os.tmpdir(), 'autopia-contrib-server-'));
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  process.env.CONTRIB_TEST_KEY = SECRET;
  delete process.env.DATABASE_URL;
  process.env.PGLITE_DIR = localDir;
  client = await import('../../src/db/client.js');
  api = await startMockApi('v1');
});

after(async () => {
  await client.closeDb().catch(() => undefined);
  await api.close();
  delete process.env.CONTRIB_TEST_KEY;
  await rm(localDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(serverDir, { recursive: true, force: true }).catch(() => undefined);
});

test('1+2: local keyed run stores redacted inputs, reproduces, and yields a secret-free bundle', async () => {
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  const { expandEnvInTarget } = await import('../../src/worker/redact.js');
  const { buildBundle, scrubBundle } = await import('../../src/worker/contribute.js');
  const db = await client.getDb();
  const target = expandEnvInTarget(validateTarget({ name: 'keyed-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello', api_key: '${CONTRIB_TEST_KEY}' } }, headers: { 'x-api-key': '${CONTRIB_TEST_KEY}' } }));
  assert.equal(target.headers?.['x-api-key'], SECRET, 'env expansion resolved the header');
  const s = await runPipeline(db, target, { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 2 });
  assert.equal(s.rejected.length, 0, 'reproduction works with the secret restored from the target');
  assert.ok(s.verified.length > 10);

  const { schema } = client;
  const trials = await db.select().from(schema.trials).where(eq(schema.trials.testRunId, s.testRunId));
  const dump = JSON.stringify(trials);
  assert.ok(!dump.includes(SECRET), 'the secret is in no stored trial');
  assert.ok(dump.includes('[redacted]'));
  const baseline = trials.find((t) => t.mutationId === 'baseline')!;
  assert.equal((baseline.input as { headers: Record<string, string> }).headers['x-api-key'], '[redacted]');
  // the mock does not validate credentials, so the bad_auth probe reports "accepted": the claim must still be redacted-safe
  const sent = api.requests.filter((r) => r.url.includes('api_key='));
  assert.ok(sent.some((r) => r.url.includes(encodeURIComponent(SECRET))), 'the REAL secret was sent on the wire');

  const built = await buildBundle(db, 'keyed-items');
  const { clean, rejected } = scrubBundle(built);
  bundle = clean;
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes('"input"') && !text.includes('"headers"') && !text.includes('"body"'), 'no inputs, headers, or bodies');
  assert.ok(bundle.trials.every((t) => t.signature.errorMessage === null || t.signature.errorMessage === '[omitted in contribution]'), 'error text omitted');
  assert.ok(bundle.claims.length > 10 && bundle.trials.length >= bundle.claims.length / 4);
  assert.equal(rejected.length, 0, JSON.stringify(rejected));
  await client.closeDb();
});

test('3+4: importing into the server database creates a contributor-tier tool with a dated banner; server tools are protected', async () => {
  process.env.PGLITE_DIR = serverDir;
  const db = await client.getDb();
  const { importContribution } = await import('../../src/db/contributions.js');
  const { renderToolDocs } = await import('../../src/db/docs.js');
  const { listTools, toolKnowledge } = await import('../../src/db/queries.js');

  const r = await importContribution(db, { keyId: null, prefix: 'ak_test01' }, bundle);
  assert.equal(r.isNewVersion, true);
  assert.equal(r.claims, bundle.claims.length);
  const tools = await listTools(db);
  assert.equal(tools[0].tier, 'contributor');
  const k = await toolKnowledge(db, 'keyed-items');
  assert.ok(k!.claims.every((c) => c.verified_by === 'contributor:ak_test01' && c.verified));
  assert.equal(new Date(k!.claims[0].verified_at).toISOString(), bundle.run.finished_at);
  const md = (await renderToolDocs(db, 'keyed-items'))!;
  assert.match(md, /Trust tier: contributor-verified/);
  assert.match(md, /contributor:ak_test01 on \d{4}-\d{2}-\d{2}/);
  assert.match(md, /NOT been re-run here since/);
  assert.match(md, /no request inputs or response bodies were uploaded/);

  // a second upload of the same bundle adds a run, not a second version
  const again = await importContribution(db, { keyId: null, prefix: 'ak_test01' }, bundle);
  assert.equal(again.isNewVersion, false);

  // server-verified tools are protected
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  await runPipeline(db, validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } }), { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 2 });
  await assert.rejects(() => importContribution(db, { keyId: null, prefix: 'ak_test01' }, { ...bundle, tool: { ...bundle.tool, name: 'mock-items' } }), /verified by this server/);

  // scrubbed again on the server: a planted statement is dropped, not stored
  const planted = { ...bundle, tool: { ...bundle.tool, name: 'keyed-items-2' }, claims: [...bundle.claims, { ...bundle.claims[0], claim_key: 'llm:other:x', statement: 'Owner is jane@example.com for this account.' }] };
  const p = await importContribution(db, { keyId: null, prefix: 'ak_test01' }, planted);
  assert.equal(p.rejected.length, 1);
  assert.equal(p.claims, bundle.claims.length);
  await client.closeDb();
});

test('5: the HTTP endpoint accepts the bundle with a key and refuses without one', async () => {
  const db = await client.getDb();
  const { createKey } = await import('../../src/db/keys.js');
  const key = (await createKey(db, 'contributor')).key;
  await client.closeDb();
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts'), '--http', String(port)], {
    env: { ...process.env, PGLITE_DIR: serverDir, AUTOPIA_LOG: 'error', AUTOPIA_MCP_TOKEN: '', AUTOPIA_MCP_OPEN: '', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const body = JSON.stringify({ ...bundle, tool: { ...bundle.tool, name: 'keyed-items-http' } });
    const anon = await fetch(`http://127.0.0.1:${port}/contribute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    assert.equal(anon.status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/contribute`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body });
    const res = (await ok.json()) as { ok: boolean; claims: number; verified_by: string };
    assert.equal(ok.status, 200, JSON.stringify(res));
    assert.equal(res.claims, bundle.claims.length);
    assert.match(res.verified_by, /^contributor:ak_/);
    const bad = await fetch(`http://127.0.0.1:${port}/contribute`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ format: 'nope' }) });
    assert.equal(bad.status, 400);
  } finally {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
});
