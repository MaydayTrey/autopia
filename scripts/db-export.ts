/**
 * Dump the whole compendium (ids preserved) to one JSON file:
 *   npx tsx scripts/db-export.ts data/export.json
 * Reads whichever database the environment points at (PGlite by default).
 */
import { writeFile } from 'node:fs/promises';
import { closeDb, getDb } from '../src/db/client.js';
import { countsOf, exportDb } from '../src/db/transfer.js';
import { loadEnv } from '../src/worker/env.js';

loadEnv();
const out = process.argv[2] ?? 'data/export.json';
const db = await getDb();
const dump = await exportDb(db);
await writeFile(out, JSON.stringify(dump));
process.stdout.write(`exported to ${out}: ${JSON.stringify(countsOf(dump))}\n`);
await closeDb();
