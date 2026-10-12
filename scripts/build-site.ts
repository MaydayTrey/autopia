/**
 * Build the static site from whichever database the environment points at.
 *
 *   npx tsx scripts/build-site.ts --out site --base https://maydaytrey.github.io/autopia
 *
 * Deployed by .github/workflows/pages.yml to GitHub Pages after the nightly refresh.
 */
import { parseArgs } from 'node:util';
import { closeDb, getDb } from '../src/db/client.js';
import { buildSite } from '../src/site/build.js';
import { loadEnv } from '../src/worker/env.js';

loadEnv();
const { values } = parseArgs({ options: { out: { type: 'string', default: 'site' }, base: { type: 'string', default: 'https://maydaytrey.github.io/autopia' }, mcp: { type: 'string' } } });
const db = await getDb();
const r = await buildSite(db, { out: values.out!, base: values.base!, mcpUrl: values.mcp });
console.log(`site: ${r.pages} pages, ${r.errors} error messages indexed -> ${values.out}`);
await closeDb();
