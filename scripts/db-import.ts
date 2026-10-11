/**
 * Load a JSON dump into whichever database the environment points at:
 *   DATABASE_URL=postgres://... npx tsx scripts/db-import.ts data/export.json
 * Additive by id and safe to re-run (existing rows are skipped).
 */
import { readFile } from 'node:fs/promises';
import { closeDb, getDb } from '../src/db/client.js';
import { countsOf, importDb, type Dump } from '../src/db/transfer.js';
import { loadEnv } from '../src/worker/env.js';

loadEnv();
const file = process.argv[2] ?? 'data/export.json';
const dump = JSON.parse(await readFile(file, 'utf8')) as Dump;
process.stdout.write(`importing ${file} (exported ${dump.exported_at}): ${JSON.stringify(countsOf(dump))}\n`);
const db = await getDb();
const after = await importDb(db, dump);
process.stdout.write(`database now holds: ${JSON.stringify(after)}\n`);
await closeDb();
