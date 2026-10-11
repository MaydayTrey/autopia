/**
 * With AUTOPIA_MCP_TOKEN set, the HTTP MCP server must refuse /mcp without the
 * bearer token and accept it with. /healthz stays open for platform checks.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOKEN = 'test-token-autopia';
let dir: string;
let child: ChildProcess;
let port: number;

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
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-mcp-auth-'));
  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts'), '--http', String(port)], {
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', AUTOPIA_MCP_TOKEN: TOKEN, DATABASE_URL: '' },
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
  child.kill();
  await new Promise((r) => child.once('exit', r));
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('mcp over http with a token: 401 without it, works with it, healthz stays open', async () => {
  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(h.status, 200);
  const anon = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
  assert.equal(anon.status, 401);
  const wrong = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(wrong.status, 401);
  const mcp = new Client({ name: 'auth-test', version: '0.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const { tools } = await mcp.listTools();
  assert.ok(tools.length >= 7);
  const res = await mcp.callTool({ name: 'list_tools', arguments: {} });
  assert.deepEqual(JSON.parse((res.content as { text: string }[])[0].text), []);
  await mcp.close();
});
