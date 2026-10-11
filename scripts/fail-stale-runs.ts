/** Mark test_runs still 'running' (a crashed or killed worker) as failed so they never count as current. */
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../src/db/client.js';
import { loadEnv } from '../src/worker/env.js';
loadEnv();
const db = await getDb();
const stale = await db.select({ id: schema.testRuns.id, v: schema.testRuns.toolVersionId, started: schema.testRuns.startedAt }).from(schema.testRuns).where(eq(schema.testRuns.status, 'running'));
for (const r of stale) {
  await db.update(schema.testRuns).set({ status: 'failed', finishedAt: new Date(), stats: sql`coalesce(stats, '{}'::jsonb) || '{"error":"worker exited before finishing (marked by fail-stale-runs)"}'::jsonb` }).where(eq(schema.testRuns.id, r.id));
  console.log(`run #${r.id} (version #${r.v}, started ${r.started.toISOString()}) -> failed`);
}
if (!stale.length) console.log('no stale runs');
await closeDb();
