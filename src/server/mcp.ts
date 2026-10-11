#!/usr/bin/env node
/**
 * Stage M5: the MCP SERVER. Read-only query tools over the compendium
 * (docs/compendium-spec.txt section 8). Logs go to stderr so stdout stays
 * clean for the stdio transport.
 *
 * Every response includes the EVIDENCE (trial references) behind each claim.
 *
 * Transports:
 *   default        stdio: a client launches this process locally (no auth).
 *   --http [port]  Streamable HTTP at POST /mcp (stateless: one transport per
 *                  request). Default port 4200, or AUTOPIA_MCP_PORT.
 *
 * Identity on HTTP: `Authorization: Bearer ak_...` per-user keys (src/db/keys.ts,
 * hashed, per-day quota, revocable), or the legacy AUTOPIA_MCP_TOKEN admin
 * token. Every tool call is logged to api_calls (key, tool, target, ok, ms).
 * With neither keys nor a token configured the endpoint is open and says so.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { closeDb, getDb } from '../db/client.js';
import { compactClaim, listTools, listVersions, resolveTool, searchClaims, suggestTools, toolKnowledge, versionDiff, type ClaimView } from '../db/queries.js';
import { renderToolDocs } from '../db/docs.js';
import { logCall, verifyKey } from '../db/keys.js';
import { getRequest, submitRequest } from '../db/requests.js';
import { importContribution } from '../db/contributions.js';
import { loadEnv } from '../worker/env.js';
import { log } from '../worker/log.js';

loadEnv();

const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true });

export interface ServerContext {
  /** api_keys.id of the caller; null for the admin token, stdio, or an open endpoint. */
  keyId: number | null;
  /** When false (stdio), calls are not logged. */
  logCalls: boolean;
  /** How the caller was identified. Submitting targets requires 'key' or 'admin'. */
  identity: 'key' | 'admin' | 'open' | 'stdio';
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

export function buildServer(ctx: ServerContext = { keyId: null, logCalls: false, identity: 'stdio' }): McpServer {
  const server = new McpServer({ name: 'autopia', version: '0.1.0' });

  /** Registers a tool with call logging (who, what, ok, ms) around the handler. */
  const tool = <A extends Record<string, unknown>>(name: string, def: { title: string; description: string; inputSchema: Record<string, z.ZodTypeAny> }, handler: (args: A) => Promise<ToolResult>) => {
    server.registerTool(name, def, (async (args: A) => {
      const t0 = performance.now();
      let ok = false;
      try {
        const res = await handler(args);
        ok = !res.isError;
        return res;
      } finally {
        if (ctx.logCalls) {
          const toolArg = (args as unknown as { tool?: unknown }).tool;
          const target = typeof toolArg === 'string' ? toolArg : null;
          logCall(await getDb(), ctx.keyId, name, target, ok, performance.now() - t0).catch((e) => log.warn('mcp', `usage log failed: ${(e as Error).message}`));
        }
      }
    }) as never);
  };

  /** "no such tool" with the closest existing names, so a caller guessing from a filename is redirected. */
  const noSuchTool = async (name: string) => {
    const s = await suggestTools(await getDb(), name);
    return fail(`no such tool: ${name}${s.length ? `. Did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''} Use list_tools for the catalogue.`);
  };
  /** Evidence over MCP is compact (one line per trial) unless verbose=true asks for response previews. */
  const shape = (claims: ClaimView[], verbose: boolean | undefined) => (verbose ? claims : claims.map(compactClaim));

  tool('list_tools', { title: 'List tools', description: 'Catalogue of tools (APIs) in the compendium with tier, version and verified-claim counts. Tool names are what every other tool takes as `tool`.', inputSchema: {} }, async () => text(await listTools(await getDb())));

  tool<{ tool: string }>('list_versions', { title: 'List versions', description: 'Versions of one tool, newest first. Each version is fingerprinted by its spec hash.', inputSchema: { tool: z.string().describe('tool name, e.g. open-meteo-forecast') } }, async ({ tool }) => {
    const db = await getDb();
    const t = await resolveTool(db, tool);
    if (!t) return noSuchTool(tool);
    const vs = await listVersions(db, t.id);
    return text(vs.map((v) => ({ id: v.id, label: v.versionLabel, spec_url: v.specUrl, spec_hash: v.specHash, discovered_at: v.discoveredAt })));
  });

  tool<{ tool: string; version?: number; kind?: string; limit?: number; offset?: number; verbose?: boolean }>(
    'get_tool_knowledge',
    {
      title: 'Get tool knowledge',
      description: 'VERIFIED behavioral claims for a tool (latest version by default), paginated, divergences from the spec flagged, each with compact evidence (trial id, probe, status, request line). Filter by kind; set verbose=true for response previews. For a one-read summary prefer get_tool_docs.',
      inputSchema: { tool: z.string(), version: z.number().int().optional().describe('tool_version id; default latest'), kind: z.string().optional().describe('required | type | auth | pagination | error_behavior | response_shape | undocumented_constraint | undocumented | other'), limit: z.number().int().min(1).max(500).optional().describe('default 100'), offset: z.number().int().min(0).optional(), verbose: z.boolean().optional() },
    },
    async ({ tool, version, kind, limit, offset, verbose }) => {
      const k = await toolKnowledge(await getDb(), tool, version ?? null, false);
      if (!k) return noSuchTool(tool);
      const all = kind ? k.claims.filter((c) => c.kind === kind) : k.claims;
      const start = offset ?? 0;
      const page = all.slice(start, start + (limit ?? 100));
      const counts: Record<string, number> = {};
      for (const c of k.claims) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
      return text({ tool: k.tool, tier: k.tier, version: k.version, run_id: k.run_id, total: all.length, offset: start, returned: page.length, counts_by_kind: counts, claims: shape(page, verbose) });
    },
  );

  tool<{ tool: string; version?: number; verbose?: boolean }>(
    'get_divergences',
    { title: 'Get divergences', description: "Only the verified claims where real behavior CONTRADICTS the tool's spec, with compact evidence. The high-value view. verbose=true adds response previews.", inputSchema: { tool: z.string(), version: z.number().int().optional(), verbose: z.boolean().optional() } },
    async ({ tool, version, verbose }) => {
      const k = await toolKnowledge(await getDb(), tool, version ?? null, true);
      if (!k) return noSuchTool(tool);
      return text({ tool: k.tool, tier: k.tier, version: k.version, run_id: k.run_id, total: k.claims.length, claims: shape(k.claims, verbose) });
    },
  );

  tool<{ query: string; tool?: string; limit?: number; verbose?: boolean }>(
    'search_claims',
    { title: 'Search claims', description: 'Search verified claims with a natural-language question, e.g. "is latitude required on /v1/forecast". Optionally restrict to one tool. Compact evidence unless verbose=true.', inputSchema: { query: z.string(), tool: z.string().optional(), limit: z.number().int().min(1).max(50).optional(), verbose: z.boolean().optional() } },
    async ({ query, tool, limit, verbose }) => {
      if (tool && !(await resolveTool(await getDb(), tool))) return noSuchTool(tool);
      return text(shape(await searchClaims(await getDb(), query, tool ?? null, limit ?? 20), verbose));
    },
  );

  tool<{ tool: string; version?: number }>(
    'get_tool_docs',
    { title: 'Get tool docs', description: 'A Markdown behavior sheet for a tool, generated from verified claims: spec contradictions first, then sibling differences, undocumented rules, and per-endpoint behavior. Each line cites the trial ids that back it. Use this when you are about to call the tool and want its real behavior in one read.', inputSchema: { tool: z.string(), version: z.number().int().optional() } },
    async ({ tool, version }) => {
      const md = await renderToolDocs(await getDb(), tool, version ?? null);
      return md ? { content: [{ type: 'text' as const, text: md }] } : await noSuchTool(tool);
    },
  );

  tool<{ tool: string; from_version: number; to_version: number }>(
    'get_version_diff',
    { title: 'Get version diff', description: 'Changelog of verified behavior between two versions of a tool: changed / added / removed claims.', inputSchema: { tool: z.string(), from_version: z.number().int(), to_version: z.number().int() } },
    async ({ tool, from_version, to_version }) => {
      const d = await versionDiff(await getDb(), tool, from_version, to_version);
      return d ? text(d) : await noSuchTool(tool);
    },
  );

  tool<{ target: Record<string, unknown> }>(
    'request_target',
    {
      title: 'Request a target',
      description:
        'Ask the compendium to test an API that is not in it yet. Pass a target object: { name, spec_url (OpenAPI 3 document), category?, include_paths?, baseline? (valid values for required params per path), optional_values?, server? }. Scope: public read-only APIs with no credentials (no headers accepted). The request is validated now (spec fetched and parsed, battery planned) and processed rules-only on the worker\'s next pass; use get_request_status with the returned id. Requires a per-user key. Quota: 3 requests per key per day.',
      inputSchema: { target: z.record(z.unknown()).describe('the target definition; see targets/*.json in the repo for examples') },
    },
    async ({ target }) => {
      if (ctx.identity !== 'key' && ctx.identity !== 'admin') return fail('request_target needs a per-user key (Authorization: Bearer ak_...)');
      try {
        const r = await submitRequest(await getDb(), ctx.keyId, target);
        return text({ request_id: r.request.id, status: r.request.status, name: r.request.name, inspection: r.inspection, note: 'Pending. The worker processes requests on its next pass (nightly); check get_request_status.' });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );

  tool<{ request_id: number }>(
    'get_request_status',
    { title: 'Get request status', description: 'Status of a target request: pending | running | done | failed, with the run id and summary once processed.', inputSchema: { request_id: z.number().int() } },
    async ({ request_id }) => {
      const r = await getRequest(await getDb(), request_id);
      if (!r) return fail(`no such request: ${request_id}`);
      return text({ id: r.id, name: r.name, spec_url: r.specUrl, status: r.status, note: r.note, test_run_id: r.testRunId, created_at: r.createdAt, finished_at: r.finishedAt, next: r.status === 'done' ? `get_tool_docs with tool "${r.name}"` : null });
    },
  );

  return server;
}

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
  // Prefer IPv4 for outbound connections: some hosts resolve AAAA records but have no IPv6
  // egress, and a connect attempt there hangs instead of failing.
  (await import('node:dns')).setDefaultResultOrder('ipv4first');
  const { default: express } = await import('express');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Liveness: answers within 5s no matter what the database is doing, so a platform health
  // check never hangs. The body reports db state; 200 means "process is up and serving".
  app.get('/healthz', async (_req, res) => {
    const db = await Promise.race([
      getDb().then(() => 'ok' as const, (e: Error) => `error: ${e.message}`),
      new Promise<string>((r) => setTimeout(() => r('pending'), 5_000)),
    ]);
    res.json({ ok: true, db });
  });

  const adminToken = process.env.AUTOPIA_MCP_TOKEN?.trim() || null;
  const openEndpoint = process.env.AUTOPIA_MCP_OPEN === '1';
  if (adminToken) log.info('mcp', 'admin token configured; per-user ak_ keys also accepted on /mcp');
  else if (openEndpoint) log.warn('mcp', 'AUTOPIA_MCP_OPEN=1: /mcp accepts unauthenticated calls');
  else log.info('mcp', 'per-user ak_ keys required on /mcp (no admin token configured)');

  app.post('/mcp', async (req, res) => {
    // Identity: per-user key, admin token, or (explicitly) open.
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let ctx: ServerContext = { keyId: null, logCalls: true, identity: 'open' };
    if (presented.startsWith('ak_')) {
      const v = await verifyKey(await getDb(), presented).catch((e: Error) => ({ ok: false as const, status: 401 as const, reason: `key check failed: ${e.message}` }));
      if (!v.ok) {
        res.status(v.status).json({ error: v.reason });
        return;
      }
      ctx = { keyId: v.key.id, logCalls: true, identity: 'key' };
    } else if (adminToken && presented === adminToken) {
      ctx = { keyId: null, logCalls: true, identity: 'admin' };
    } else if (!openEndpoint) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    const server = buildServer(ctx);
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
  // Contributor tier: a keyed user uploads a bundle built locally by `autopia contribute`.
  // The bundle carries claims + status/shape evidence only; the server scrubs statements again.
  app.post('/contribute', express.json({ limit: '8mb' }), async (req, res) => {
    const auth = req.headers.authorization ?? '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    let contributor: { keyId: number | null; prefix: string } | null = null;
    if (presented.startsWith('ak_')) {
      const v = await verifyKey(await getDb(), presented).catch((e: Error) => ({ ok: false as const, status: 401 as const, reason: `key check failed: ${e.message}` }));
      if (!v.ok) {
        res.status(v.status).json({ error: v.reason });
        return;
      }
      contributor = { keyId: v.key.id, prefix: v.key.prefix };
    } else if (adminToken && presented === adminToken) {
      contributor = { keyId: null, prefix: 'admin' };
    }
    if (!contributor) {
      res.status(401).json({ error: 'contributions need a per-user key (Authorization: Bearer ak_...)' });
      return;
    }
    const t0 = performance.now();
    try {
      const r = await importContribution(await getDb(), contributor, req.body);
      await logCall(await getDb(), contributor.keyId, 'contribute', (req.body as { tool?: { name?: string } })?.tool?.name ?? null, true, performance.now() - t0).catch(() => undefined);
      res.json({ ok: true, ...r, verified_by: `contributor:${contributor.prefix}` });
    } catch (e) {
      await logCall(await getDb(), contributor.keyId, 'contribute', (req.body as { tool?: { name?: string } })?.tool?.name ?? null, false, performance.now() - t0).catch(() => undefined);
      res.status(400).json({ error: (e as Error).message });
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
