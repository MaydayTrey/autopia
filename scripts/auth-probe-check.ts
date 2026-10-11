import { and, eq, like } from 'drizzle-orm';
import { closeDb, getDb, schema } from '../src/db/client.js';
import { loadEnv } from '../src/worker/env.js';
loadEnv();
const db = await getDb();
const rows = await db.select().from(schema.trials).where(and(eq(schema.trials.testRunId, Number(process.argv[2])), like(schema.trials.mutationId, '%auth%')));
for (const t of rows) {
  const r = t.response as { headers: Record<string, string> };
  const h = (t.input as { headers: Record<string, string> }).headers;
  console.log(`${t.endpoint.padEnd(36)} ${t.mutationId.padEnd(26)} status ${t.statusCode}  stored-authorization=${JSON.stringify(h.authorization)}  x-ratelimit-limit=${r.headers['x-ratelimit-limit']}`);
}
await closeDb();
