#!/usr/bin/env node
/**
 * Stage M5: the MCP SERVER. Read-only query tools over the compendium
 * (docs/compendium-spec.txt section 8). Talks MCP over stdio; logs go to
 * stderr so stdout stays clean.
 *
 * Every response includes the EVIDENCE (trial references) behind each claim.
 *
 * Register in an MCP client (e.g. Claude Code) as:
 *   command: npx   args: ["tsx", "C:/Users/sunwa/Desktop/Autopia/src/server/mcp.ts"]
 *
 * PGlite caveat: one process at a time. Stop the worker before starting this.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { closeDb, getDb } from '../db/client.js';
import { listTools, listVersions, resolveTool, searchClaims, toolKnowledge, versionDiff } from '../db/queries.js';
import { renderToolDocs } from '../db/docs.js';
import { loadEnv } from '../worker/env.js';
import { log } from '../worker/log.js';

loadEnv();

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true });

export function buildServer(): McpServer {
  const server = new McpServer({ name: 'autopia', version: '0.1.0' });

  server.registerTool(
    'list_tools',
    { title: 'List tools', description: 'Catalogue of tools (APIs) in the compendium with version and verified-claim counts.', inputSchema: {} },
    async () => text(await listTools(await getDb())),
  );

  server.registerTool(
    'list_versions',
    { title: 'List versions', description: 'Versions of one tool, newest first. Each version is fingerprinted by its spec hash.', inputSchema: { tool: z.string().describe('tool name, e.g. open-meteo-forecast') } },
    async ({ tool }) => {
      const db = await getDb();
      const t = await resolveTool(db, tool);
      if (!t) return fail(`no such tool: ${tool}`);
      const vs = await listVersions(db, t.id);
      return text(vs.map((v) => ({ id: v.id, label: v.versionLabel, spec_url: v.specUrl, spec_hash: v.specHash, discovered_at: v.discoveredAt })));
    },
  );

  server.registerTool(
    'get_tool_knowledge',
    {
      title: 'Get tool knowledge',
      description: 'All VERIFIED behavioral claims for a tool (latest version by default), grouped by kind, divergences from the spec flagged, each with its evidence trials.',
      inputSchema: { tool: z.string(), version: z.number().int().optional().describe('tool_version id; default latest') },
    },
    async ({ tool, version }) => {
      const k = await toolKnowledge(await getDb(), tool, version ?? null, false);
      return k ? text(k) : fail(`no such tool: ${tool}`);
    },
  );

  server.registerTool(
    'get_divergences',
    {
      title: 'Get divergences',
      description: 'Only the verified claims where real behavior CONTRADICTS the tool\'s spec. The high-value view.',
      inputSchema: { tool: z.string(), version: z.number().int().optional() },
    },
    async ({ tool, version }) => {
      const k = await toolKnowledge(await getDb(), tool, version ?? null, true);
      return k ? text(k) : fail(`no such tool: ${tool}`);
    },
  );

  server.registerTool(
    'search_claims',
    {
      title: 'Search claims',
      description: 'Search verified claims with a natural-language question, e.g. "is latitude required on /v1/forecast". Optionally restrict to one tool.',
      inputSchema: { query: z.string(), tool: z.string().optional(), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ query, tool, limit }) => text(await searchClaims(await getDb(), query, tool ?? null, limit ?? 20)),
  );

  server.registerTool(
    'get_tool_docs',
    {
      title: 'Get tool docs',
      description: 'A Markdown behavior sheet for a tool, generated from verified claims: spec contradictions first, then sibling differences, undocumented rules, and per-endpoint behavior. Each line cites the trial ids that back it. Use this when you are about to call the tool and want its real behavior in one read.',
      inputSchema: { tool: z.string(), version: z.number().int().optional() },
    },
    async ({ tool, version }) => {
      const md = await renderToolDocs(await getDb(), tool, version ?? null);
      return md ? { content: [{ type: 'text' as const, text: md }] } : fail(`no such tool: ${tool}`);
    },
  );

  server.registerTool(
    'get_version_diff',
    {
      title: 'Get version diff',
      description: 'Changelog of verified behavior between two versions of a tool: changed / added / removed claims.',
      inputSchema: { tool: z.string(), from_version: z.number().int(), to_version: z.number().int() },
    },
    async ({ tool, from_version, to_version }) => {
      const d = await versionDiff(await getDb(), tool, from_version, to_version);
      return d ? text(d) : fail(`no such tool: ${tool}`);
    },
  );

  return server;
}

/**
 * Two transports:
 *   default        stdio: a client launches this process locally.
 *   --http [port]  Streamable HTTP at POST /mcp (stateless: one transport per request),
 *                  for agents elsewhere. Default port 4200, or AUTOPIA_MCP_PORT.
 */
async function main() {
  const httpIdx = process.argv.indexOf('--http');
  if (httpIdx === -1) {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log.info('mcp', 'autopia MCP server ready on stdio');
    const shutdown = async () => {
      await server.close().catch(() => undefined);
      await closeDb();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.on('close', shutdown);
    return;
  }

  const port = Number(process.argv[httpIdx + 1] ?? process.env.AUTOPIA_MCP_PORT ?? 4200);
  const { default: express } = await import('express');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/healthz', async (_req, res) => {
    try {
      await getDb();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });
  app.post('/mcp', async (req, res) => {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error('mcp', `request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => res.status(405).json({ error: 'stateless server: use POST /mcp' });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
  const listener = app.listen(port, () => log.info('mcp', `autopia MCP server ready at http://localhost:${port}/mcp`));
  const shutdown = () => listener.close(() => closeDb().then(() => process.exit(0)));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && /mcp\.(ts|js)$/.test(process.argv[1]);
if (isMain) main().catch((e) => {
  log.error('mcp', (e as Error).message);
  process.exit(1);
});
