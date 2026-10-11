/**
 * Export / import the whole compendium as one JSON document, ids preserved,
 * for moving between databases (embedded PGlite -> managed Postgres).
 * Import is additive by id: rows that already exist are skipped, so it is
 * safe to re-run. Sequences are reset afterwards so new rows get fresh ids.
 */
import { asc, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';

export interface Dump {
  exported_at: string;
  tools: (typeof schema.tools.$inferSelect)[];
  tool_versions: (typeof schema.toolVersions.$inferSelect)[];
  test_runs: (typeof schema.testRuns.$inferSelect)[];
  trials: (typeof schema.trials.$inferSelect)[];
  claims: (typeof schema.claims.$inferSelect)[];
  claim_diffs: (typeof schema.claimDiffs.$inferSelect)[];
}

export async function exportDb(db: Db): Promise<Dump> {
  return {
    exported_at: new Date().toISOString(),
    tools: await db.select().from(schema.tools).orderBy(asc(schema.tools.id)),
    tool_versions: await db.select().from(schema.toolVersions).orderBy(asc(schema.toolVersions.id)),
    test_runs: await db.select().from(schema.testRuns).orderBy(asc(schema.testRuns.id)),
    trials: await db.select().from(schema.trials).orderBy(asc(schema.trials.id)),
    claims: await db.select().from(schema.claims).orderBy(asc(schema.claims.id)),
    claim_diffs: await db.select().from(schema.claimDiffs).orderBy(asc(schema.claimDiffs.id)),
  };
}

export function countsOf(d: Dump): Record<string, number> {
  return { tools: d.tools.length, tool_versions: d.tool_versions.length, test_runs: d.test_runs.length, trials: d.trials.length, claims: d.claims.length, claim_diffs: d.claim_diffs.length };
}

const BATCH = 200;

async function insertBatches<T extends Record<string, unknown>>(db: Db, table: Parameters<Db['insert']>[0], rows: T[]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.insert(table).values(rows.slice(i, i + BATCH) as never).onConflictDoNothing();
  }
}

const reviveDates = <T extends Record<string, unknown>>(rows: T[], keys: string[]): T[] =>
  rows.map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of keys) if (typeof out[k] === 'string') out[k] = new Date(out[k] as string);
    return out as T;
  });

export async function importDb(db: Db, d: Dump): Promise<Record<string, number>> {
  // Parent tables first (foreign keys). JSON turned Date into string; turn it back.
  await insertBatches(db, schema.tools, reviveDates(d.tools, ['createdAt']));
  await insertBatches(db, schema.toolVersions, reviveDates(d.tool_versions, ['discoveredAt']));
  await insertBatches(db, schema.testRuns, reviveDates(d.test_runs, ['startedAt', 'finishedAt']));
  await insertBatches(db, schema.trials, reviveDates(d.trials, ['createdAt']));
  await insertBatches(db, schema.claims, reviveDates(d.claims, ['createdAt']).map((c) => ({ ...c, embedding: c.embedding ?? null })));
  await insertBatches(db, schema.claimDiffs, reviveDates(d.claim_diffs, ['createdAt']));
  for (const t of ['tools', 'tool_versions', 'test_runs', 'trials', 'claims', 'claim_diffs']) {
    await db.execute(sql.raw(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`));
  }
  const after = await exportDb(db);
  return countsOf(after);
}
