/**
 * AUTOPIA_OFFLINE=1: the HTTP server answers /healthz (so the host keeps it alive) and refuses
 * everything else with 503 without touching the database. The kill switch for a traffic flood.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-offline-'));
  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts'), '--http', String(port)], {
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', DATABASE_URL: '', AUTOPIA_MCP_TOKEN: '', AUTOPIA_OFFLINE: '1', AUTOPIA_OFFLINE_MESSAGE: 'down for maintenance' },
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

test('offline: healthz says so, /mcp and /contribute are 503 with retry-after, anonymous or not', async () => {
  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true, offline: true, db: 'not checked' });
  for (const [p, headers] of [
    ['/mcp', {}],
    ['/mcp', { authorization: 'Bearer ak_' + 'a'.repeat(40) }],
    ['/contribute', {}],
  ] as const) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tools","arguments":{}}}' });
    assert.equal(r.status, 503, p);
    assert.equal(r.headers.get('retry-after'), '3600');
    assert.deepEqual(await r.json(), { error: 'offline', message: 'down for maintenance' });
  }
});
