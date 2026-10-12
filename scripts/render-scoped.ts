/**
 * Render a behavior sheet the way the plugin hook asks for it: brief and scoped to one request
 * path. Handy for judging what an agent actually receives.
 *
 *   npx tsx scripts/render-scoped.ts github-rest /repos/github/rest-api-description/issues
 *   npx tsx scripts/render-scoped.ts github-rest /rate_limit --full
 */
import { closeDb, getDb } from '../src/db/client.js';
import { renderToolDocs } from '../src/db/docs.js';
import { loadEnv } from '../src/worker/env.js';

loadEnv();
const [tool, reqPath, flag] = process.argv.slice(2);
if (!tool) {
  console.error('usage: render-scoped.ts <tool> [path] [--full]');
  process.exit(2);
}
const db = await getDb();
const md = await renderToolDocs(db, tool, null, { brief: flag !== '--full', path: reqPath ?? null });
if (!md) {
  console.error(`no such tool: ${tool}`);
  process.exit(1);
}
console.log(`[${md.length} chars]`);
console.log(md);
await closeDb();
