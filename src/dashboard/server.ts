/**
 * M6 (optional): minimal read-only dashboard for demos.
 * Express serves a small JSON API over the same read queries the MCP server
 * uses, plus one static page. Port 4100. PGlite caveat: stop the worker first.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { closeDb, getDb } from '../db/client.js';
import { listTools, listVersions, resolveTool, runsForTool, searchClaims, toolKnowledge, trialById, versionDiff } from '../db/queries.js';
import { renderToolDocs } from '../db/docs.js';
import { loadEnv } from '../worker/env.js';
import { log } from '../worker/log.js';

loadEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.AUTOPIA_DASHBOARD_PORT ?? 4100);

const wrap = (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
  try {
    const v = await fn(req);
    if (v === null || v === undefined) res.status(404).json({ error: 'not found' });
    else res.json(v);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
};

app.get('/api/tools', wrap(async () => listTools(await getDb())));
app.get('/api/tools/:name/versions', wrap(async (req) => {
  const db = await getDb();
  const t = await resolveTool(db, String(req.params.name));
  return t ? listVersions(db, t.id) : null;
}));
app.get('/api/tools/:name/runs', wrap(async (req) => {
  const db = await getDb();
  const t = await resolveTool(db, String(req.params.name));
  return t ? runsForTool(db, t.id) : null;
}));
app.get('/api/tools/:name/claims', wrap(async (req) => toolKnowledge(await getDb(), String(req.params.name), req.query.version ? Number(req.query.version) : null, req.query.divergences === '1')));
app.get('/api/tools/:name/diff', wrap(async (req) => versionDiff(await getDb(), String(req.params.name), Number(req.query.from), Number(req.query.to))));
app.get('/api/search', wrap(async (req) => searchClaims(await getDb(), String(req.query.q ?? ''), req.query.tool ? String(req.query.tool) : null)));
app.get('/api/tools/:name/docs', async (req, res) => {
  try {
    const md = await renderToolDocs(await getDb(), String(req.params.name), req.query.version ? Number(req.query.version) : null);
    if (!md) res.status(404).type('text/plain').send('not found');
    else res.type('text/markdown').send(md);
  } catch (e) {
    res.status(500).type('text/plain').send((e as Error).message);
  }
});
app.get('/api/trials/:id', wrap(async (req) => trialById(await getDb(), Number(String(req.params.id)))));
app.use(express.static(path.join(here, 'public')));

const server = app.listen(PORT, () => log.info('dashboard', `http://localhost:${PORT}`));
const shutdown = () => server.close(() => closeDb().then(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
