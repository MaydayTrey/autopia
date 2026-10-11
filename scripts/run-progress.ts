/** Progress of a run: trials logged so far, status counts, last trial time. Usage: npx tsx scripts/run-progress.ts <runId> */
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../src/db/client.js';
import { loadEnv } from '../src/worker/env.js';
loadEnv();
const id = Number(process.argv[2]);
const db = await getDb();
const [run] = await db.select().from(schema.testRuns).where(eq(schema.testRuns.id, id));
const rows = await db.select({ status: schema.trials.statusCode, n: sql<number>`count(*)::int`, last: sql<string>`max(${schema.trials.createdAt})::text` }).from(schema.trials).where(eq(schema.trials.testRunId, id)).groupBy(schema.trials.statusCode);
console.log(`run #${id} ${run?.status} started ${run?.startedAt.toISOString()}`);
for (const r of rows) console.log(`  status ${r.status}: ${r.n} trials, last at ${r.last}`);
await closeDb();
