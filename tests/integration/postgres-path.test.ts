/**
 * Exercises the REAL Postgres code path (DATABASE_URL -> node-postgres driver,
 * migrator, CREATE EXTENSION vector) without Docker: a PGlite instance serves
 * the Postgres wire protocol on a local TCP port via pglite-socket, and the
 * pipeline connects to it exactly as it would to Neon or Supabase.
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

let dir: string;
let pg: PGlite;
let socket: PGLiteSocketServer;
let api: MockApi;
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

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-pgwire-'));
  pg = await PGlite.create({ dataDir: dir, extensions: { vector } });
  const port = await freePort();
  socket = new PGLiteSocketServer({ db: pg, port, host: '127.0.0.1' });
  await socket.start();
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  delete process.env.PGLITE_DIR;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  client = await import('../../src/db/client.js');
  api = await startMockApi('v1');
});

after(async () => {
  await client.closeDb().catch(() => undefined);
  await socket.stop().catch(() => undefined);
  await pg.close().catch(() => undefined);
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  delete process.env.DATABASE_URL;
});

test('pipeline runs end to end through the node-postgres driver (migrations, pgvector, queries)', async () => {
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  const queries = await import('../../src/db/queries.js');
  const db = await client.getDb();
  const s = await runPipeline(db, validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } }), { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 1 });
  assert.equal(s.rejected.length, 0);
  assert.ok(s.verified.length > 10);
  assert.ok(s.divergences >= 3);
  const k = await queries.toolKnowledge(db, 'mock-items');
  assert.equal(k?.claims.length, s.verified.length);
  const hits = await queries.searchClaims(db, 'unknown query parameters', 'mock-items');
  assert.ok(hits.length >= 1, 'full-text search works on real Postgres');
  // the vector column exists and is NULL for v1 (no embeddings yet)
  const rows = await pg.query<{ n: string }>(`select count(*)::text as n from claims where embedding is null`);
  assert.equal(Number(rows.rows[0].n), s.verified.length);
});
