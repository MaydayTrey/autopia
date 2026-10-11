/**
 * Export from the embedded PGlite, import into a Postgres-wire server
 * (PGlite behind pglite-socket, same path a managed Postgres takes), and
 * check: counts match, ids are preserved, re-import is a no-op, and a fresh
 * insert afterwards gets an id above the imported ones (sequences reset).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { startMockApi, type MockApi } from '../mock-api/server.js';
import { countsOf, exportDb, importDb, type Dump } from '../../src/db/transfer.js';

let srcDir: string;
let dstDir: string;
let pg: PGlite;
let socket: PGLiteSocketServer;
let api: MockApi;
let client: typeof import('../../src/db/client.js');
let dump: Dump;

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
  srcDir = await mkdtemp(path.join(os.tmpdir(), 'autopia-xfer-src-'));
  dstDir = await mkdtemp(path.join(os.tmpdir(), 'autopia-xfer-dst-'));
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  // 1. populate the SOURCE (embedded PGlite) with one run and export it
  process.env.PGLITE_DIR = srcDir;
  delete process.env.DATABASE_URL;
  client = await import('../../src/db/client.js');
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  api = await startMockApi('v1');
  const src = await client.getDb();
  await runPipeline(src, validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } }), { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 2 });
  dump = JSON.parse(JSON.stringify(await exportDb(src))); // through JSON, like the file would be
  await client.closeDb();
  // 2. bring up the DESTINATION over the Postgres wire protocol
  pg = await PGlite.create({ dataDir: dstDir, extensions: { vector } });
  const port = await freePort();
  socket = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
  await socket.start();
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  delete process.env.PGLITE_DIR;
});

after(async () => {
  await client.closeDb().catch(() => undefined);
  await socket.stop().catch(() => undefined);
  await pg.close().catch(() => undefined);
  await api.close();
  await rm(srcDir, { recursive: true, force: true }).catch(() => undefined);
  await rm(dstDir, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.DATABASE_URL;
});

test('export -> import preserves every row and id; re-import is idempotent; sequences continue', async () => {
  const before = countsOf(dump);
  assert.ok(before.claims > 10 && before.trials > 30, `source has data: ${JSON.stringify(before)}`);
  const dst = await client.getDb();
  const after = await importDb(dst, dump);
  assert.deepEqual(after, before);
  const again = await importDb(dst, dump);
  assert.deepEqual(again, before, 're-import adds nothing');
  const queries = await import('../../src/db/queries.js');
  const k = await queries.toolKnowledge(dst, 'mock-items');
  assert.equal(k?.claims.length, before.claims);
  assert.ok(k!.claims.every((c) => c.evidence.length >= 1), 'evidence trials came across with matching ids');
  const { schema } = client;
  const [fresh] = await dst.insert(schema.tools).values({ name: 'after-import', kind: 'rest_api' }).returning();
  assert.ok(fresh.id > Math.max(...dump.tools.map((t) => t.id)), 'new ids continue past imported ones');
});
