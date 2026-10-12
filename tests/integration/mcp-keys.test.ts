/**
 * Per-user keys on the HTTP MCP server: a key minted into a throwaway database
 * authenticates, its calls are logged with the tool name and target, a wrong
 * key is refused, a revoked key is refused, and the per-day quota yields 429.
 * No admin token is configured, so keys are the only way in.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startMockApi, type MockApi } from '../mock-api/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir: string;
let api: MockApi;
let child: ChildProcess;
let port: number;
let goodKey: string;
let smallQuotaKey: string;
let revokedKey: string;
let client: typeof import('../../src/db/client.js');

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a !== 'string' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function connect(key: string): Promise<Client> {
  const c = new Client({ name: 'keys-test', version: '0.0.0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return c;
}

async function rawPost(key: string | null): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  await r.text();
  return r.status;
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-keys-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  client = await import('../../src/db/client.js');
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  const { createKey, revokeKey } = await import('../../src/db/keys.js');
  api = await startMockApi('v1');
  const db = await client.getDb();
  await runPipeline(db, validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } }), { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 4 });
  goodKey = (await createKey(db, 'alice')).key;
  smallQuotaKey = (await createKey(db, 'bob', 2)).key;
  revokedKey = (await createKey(db, 'carol')).key;
  await revokeKey(db, 'carol');
  await client.closeDb(); // PGlite: one process; hand the dir to the server

  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts'), '--http', String(port)], {
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', AUTOPIA_MCP_TOKEN: '', AUTOPIA_MCP_OPEN: '', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
});

after(async () => {
  if (child.exitCode === null && !child.killed) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('keys: no key and a non-key bearer are anonymous readers (200); a wrong, malformed or revoked ak_ key is 401', async () => {
  assert.equal(await rawPost(null), 200, 'reads are anonymous');
  assert.equal(await rawPost('not-a-key'), 200, 'a bearer that is not an ak_ key (e.g. an unexpanded placeholder) reads anonymously');
  assert.equal(await rawPost('ak_' + 'x'.repeat(40)), 401, 'an unknown ak_ key is an error the caller must notice');
  assert.equal(await rawPost('ak_short'), 401, 'malformed');
  assert.equal(await rawPost(revokedKey), 401, 'revoked');
});

test('keys: the per-day quota counts tool calls and then returns 429', async () => {
  const mcp = await connect(smallQuotaKey); // quota 2
  await mcp.callTool({ name: 'list_tools', arguments: {} });
  await mcp.callTool({ name: 'list_tools', arguments: {} });
  await mcp.close();
  assert.equal(await rawPost(smallQuotaKey), 429);
  assert.equal(await rawPost(goodKey), 200, 'other keys are unaffected');
});

test('keys: a valid key works and its calls are logged with tool and target', async () => {
  const mcp = await connect(goodKey);
  const { tools } = await mcp.listTools();
  assert.ok(tools.length >= 7);
  const res = await mcp.callTool({ name: 'get_divergences', arguments: { tool: 'mock-items' } });
  assert.ok(!res.isError);
  const missing = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'nope' } });
  assert.equal(missing.isError, true);
  await mcp.close();
  // read the log from the server's database after it has had a moment to write
  await new Promise((r) => setTimeout(r, 300));
  child.kill();
  await new Promise((r) => child.once('exit', r));
  const db = await client.getDb();
  const { usageSummary, listKeys } = await import('../../src/db/keys.js');
  const u = await usageSummary(db, 1);
  const alice = u.byKeyTool.filter((r) => r.name === 'alice');
  assert.ok(alice.some((r) => r.tool === 'get_divergences' && r.calls === 1 && r.errors === 0), JSON.stringify(alice));
  assert.ok(alice.some((r) => r.tool === 'get_tool_docs' && r.errors === 1), 'the failed lookup is logged as an error');
  assert.ok(u.byTarget.some((t) => t.target === 'mock-items'), 'target demand is recorded');
  const keys = await listKeys(db);
  assert.ok(keys.find((k) => k.name === 'alice')!.last_used_at, 'last_used_at updated');
  await client.closeDb();
});
