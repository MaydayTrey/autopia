/**
 * The MCP server over Streamable HTTP: spawn `mcp.ts --http <port>` on a
 * throwaway database populated by one mock-API run, then talk to it with the
 * SDK's HTTP client. This is the transport agents elsewhere would use.
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
let mcp: Client;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a !== 'string' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function waitFor(url: string, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-mcp-http-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  const client = await import('../../src/db/client.js');
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  api = await startMockApi('v1');
  const db = await client.getDb();
  await runPipeline(db, validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } }), { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 4 });
  await client.closeDb();

  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts'), '--http', String(port)], {
    // DATABASE_URL: '' pins the child to its throwaway PGlite even when .env points at a real Postgres.
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', DATABASE_URL: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitFor(`http://127.0.0.1:${port}/healthz`, 30_000);
  mcp = new Client({ name: 'autopia-http-test', version: '0.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
});

after(async () => {
  await mcp.close().catch(() => undefined);
  child.kill();
  await new Promise((r) => child.once('exit', r));
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('mcp over http: healthz, tool list, and a real query', async () => {
  const h = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
  assert.equal(h.ok, true);
  assert.equal(h.db, 'ok');
  const { tools } = await mcp.listTools();
  assert.ok(tools.some((t) => t.name === 'get_tool_docs'));
  const res = await mcp.callTool({ name: 'get_divergences', arguments: { tool: 'mock-items' } });
  const d = JSON.parse((res.content as { text: string }[])[0].text);
  assert.ok(d.claims.length >= 3);
  assert.ok(d.claims.every((c: { verified: boolean }) => c.verified));
});

test('mcp over http: stateless server rejects GET on /mcp', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`);
  assert.equal(r.status, 405);
});
