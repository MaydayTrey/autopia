/**
 * One database handle for the whole app.
 *
 * - No DATABASE_URL  -> embedded PGlite (Postgres compiled to WASM), files in ./data/pglite.
 *                       Zero install. ONE process at a time can hold it open.
 * - DATABASE_URL set -> real Postgres via node-postgres. Same schema, same queries.
 *
 * Migrations live in ./drizzle (generated from src/db/schema.ts by `npx drizzle-kit generate`)
 * and are applied automatically on first connect.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(ROOT, 'drizzle');

let handle: { db: Db; close: () => Promise<void> } | null = null;

export async function getDb(): Promise<Db> {
  if (handle) return handle.db;
  const url = process.env.DATABASE_URL?.trim();
  handle = url ? await openPostgres(url) : await openPglite();
  return handle.db;
}

export async function closeDb(): Promise<void> {
  if (!handle) return;
  await handle.close();
  handle = null;
}

async function openPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');

  const dataDir = process.env.PGLITE_DIR ?? path.join(ROOT, 'data', 'pglite');
  const client = await PGlite.create({ dataDir, extensions: { vector } });
  await client.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => client.close() };
}

async function openPostgres(url: string) {
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');

  // Fail fast: without a connect timeout a hung route (e.g. IPv6 with no egress) blocks forever,
  // which is how a health check turns into a deploy timeout.
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000, max: 5 });
  // An idle client dropped by the server (managed Postgres does this) emits 'error' on the pool.
  // Unhandled, that event crashes the process mid-run; handled, the pool simply replaces the client.
  pool.on('error', (e) => process.stderr.write(`warn: idle database connection dropped (${e.message}); pool will reconnect\n`));
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector;');
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => pool.end() };
}

export { schema };
