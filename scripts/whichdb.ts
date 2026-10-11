import { sql } from 'drizzle-orm';
import { getDb, closeDb } from '../src/db/client.js';
import { loadEnv } from '../src/worker/env.js';
loadEnv();
const db = await getDb();
const r = await db.execute(sql`select version() as v, current_database() as d`);
const row = (r as unknown as { rows?: Record<string, unknown>[] }).rows?.[0] ?? (r as unknown as Record<string, unknown>[])[0];
console.log(JSON.stringify(row));
await closeDb();
