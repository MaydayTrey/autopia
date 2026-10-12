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
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', AUTOPIA_MCP_TOKEN: TOKEN, DATABASE_URL: '', AUTOPIA_ANON_PER_MINUTE: '4' },
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

const call = (name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

test('mcp over http: anonymous READS work under a per-IP limit; bad keys are 401; request_target needs a key; the admin token works; healthz stays open', async () => {
  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(h.status, 200);
  // No credential: a reader.
  const anon = await call('list_tools', {});
  assert.equal(anon.status, 200);
  // An unexpanded placeholder (a plugin whose key is not configured) is a reader too.
  const placeholder = await call('list_tools', {}, { authorization: 'Bearer ${user_config.autopia_key}' });
  assert.equal(placeholder.status, 200);
  // A malformed or unknown ak_ key is an error, so the caller notices.
  assert.equal((await call('list_tools', {}, { authorization: 'Bearer ak_nope' })).status, 401);
  assert.equal((await call('list_tools', {}, { authorization: `Bearer ak_${'a'.repeat(40)}` })).status, 401);
  // Anonymous callers cannot submit targets.
  const rt = await call('request_target', { target: { name: 'x', spec_url: 'https://example.com/openapi.json' } });
  assert.equal(rt.status, 200);
  assert.match(await rt.text(), /needs a per-user key/);
  // The per-minute limit (4 in this server's env): anon, placeholder and request_target used 3; one more is fine, the next is 429.
  assert.equal((await call('list_tools', {})).status, 200);
  const limited = await call('list_tools', {});
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.match(await limited.text(), /rate limit \(4\/min\)/);
  // Anonymous callers never get verbose previews, even when they ask (the response cache serves them compact).
  // The admin token is not subject to the anonymous limit.
  const mcp = new Client({ name: 'auth-test', version: '0.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const { tools } = await mcp.listTools();
  assert.ok(tools.length >= 7);
  const res = await mcp.callTool({ name: 'list_tools', arguments: {} });
  assert.deepEqual(JSON.parse((res.content as { text: string }[])[0].text), []);
  await mcp.close();
});
