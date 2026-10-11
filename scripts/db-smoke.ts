import { getDb, closeDb, schema } from '../src/db/client.js';
const db = await getDb();
const rows = await db.select().from(schema.tools);
console.log('db ok, tools:', rows.length);
await closeDb();
