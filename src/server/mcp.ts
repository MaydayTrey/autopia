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
import { timingSafeEqual } from 'node:crypto';
import { AnonLimiter } from './anon-limiter.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { closeDb, getDb } from '../db/client.js';
import { compactClaim, listTools, listVersions, pathOf, resolveToolRef, searchClaims, suggestTools, toolKnowledge, versionDiff, type ClaimView } from '../db/queries.js';
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
  /** How the caller was identified. Submitting targets requires 'key' or 'admin'; 'anon' is a rate-limited read-only caller. */
  identity: 'key' | 'admin' | 'open' | 'stdio' | 'anon';
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Constant-time string equality for bearer tokens (length leak is acceptable: the token is random). */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Injected into the client's context at connect time. Written for the MOMENT an agent
 * would need the compendium (about to call an API; an API call just failed), not as a
 * description of the compendium: an agent whose current thought is "curl the issues
 * endpoint" has to recognise itself in the first lines.
 */
export const INSTRUCTIONS = `Autopia is a compendium of VERIFIED HTTP API behavior. Every claim was produced by probing the live API, reproduced on a re-run before it was stored, and cites the trial ids behind it. It records what an API's OpenAPI spec gets wrong and what it never says: parameters that are silently ignored or clamped, the real error body per status, what happens past the last page, auth and rate-limit behavior, accepted date formats, undocumented required combinations.

TRIGGER (do this without being asked):
- BEFORE your first request in a session to any host the compendium covers, call get_tool_docs with that host or URL, e.g. get_tool_docs {"tool":"api.github.com"}. Covered hosts include api.github.com, registry.npmjs.org, pypi.org, api.anthropic.com and api.open-meteo.com; list_tools shows all of them with their hosts. One read replaces trial-and-error against the API.
- AFTER an API call fails or surprises you (an unexpected 4xx/5xx, a parameter that seems ignored, an empty or odd page, a filter that returns the wrong rows): call search_claims with the host and the symptom, e.g. "github per_page 500" or "npm search size 0".
- When choosing between endpoints or between sibling APIs, get_divergences shows where each one contradicts its own spec.

SKIP: hosts not listed by list_tools (request_target can queue a public read-only API); write endpoints (POST/PUT/DELETE are not probed yet); a behavior sheet you already read this session.

SCOPE: pass the full URL (or path) you are about to call to get_tool_docs to receive ONLY that endpoint plus a one-line index of the others; add brief:true for the short form. Descend to another endpoint by its path instead of reading the whole tool.

TRUST: 'server' tier claims were re-verified by this server on the run shown in the sheet. 'contributor-verified' claims were run by a keyed user and not re-run since; the date says how stale they are. Nothing here is inferred from documentation; every line cites trials.`;

export function buildServer(ctx: ServerContext = { keyId: null, logCalls: false, identity: 'stdio' }): McpServer {
  const server = new McpServer({ name: 'autopia', version: '0.1.0' }, { instructions: INSTRUCTIONS });

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
    return fail(`no such tool: ${name}${s.length ? `. Did you mean ${s.map((x) => `"${x}"`).join(' or ')}?` : ''} Pass a tool name, or the host / URL you are about to call; list_tools shows the catalogue with hosts.`);
  };
  /** `tool` may be a name, a host or a URL; returns the canonical name or an error result. */
  const resolveName = async (ref: string): Promise<{ name: string } | { error: ToolResult }> => {
    const r = await resolveToolRef(await getDb(), ref);
    if (!r) return { error: await noSuchTool(ref) };
    if ('ambiguous' in r) return { error: fail(`${r.ambiguous.length} tools cover ${r.host}: ${r.ambiguous.map((x) => `"${x}"`).join(', ')}. Pass one of them as tool.`) };
    return { name: r.tool.name };
  };
  const TOOL_ARG = z.string().describe('tool name (e.g. github-rest), or the host / URL you are about to call (e.g. api.github.com)');
  /** Evidence over MCP is compact (one line per trial) unless verbose=true asks for response previews. */
  const shape = (claims: ClaimView[], verbose: boolean | undefined) => (verbose ? claims : claims.map(compactClaim));

  tool('list_tools', { title: 'List tools', description: 'Which APIs the compendium covers, each with the HOSTS its trials hit (match the URL you are about to call), trust tier, version count and verified-claim / divergence counts. Call once per session; then get_tool_docs for the host you are about to call.', inputSchema: {} }, async () => text(await listTools(await getDb())));

  tool<{ tool: string }>('list_versions', { title: 'List versions', description: 'Spec versions of one API, newest first, each fingerprinted by its spec hash. Use with get_version_diff when a spec changed and you want to know what changed in BEHAVIOR.', inputSchema: { tool: TOOL_ARG } }, async ({ tool }) => {
    const db = await getDb();
    const r = await resolveToolRef(db, tool);
    if (!r) return noSuchTool(tool);
    if ('ambiguous' in r) return (await resolveName(tool) as { error: ToolResult }).error;
    const vs = await listVersions(db, r.tool.id);
    return text(vs.map((v) => ({ id: v.id, label: v.versionLabel, spec_url: v.specUrl, spec_hash: v.specHash, discovered_at: v.discoveredAt })));
  });

  tool<{ tool: string; version?: number; kind?: string; limit?: number; offset?: number; verbose?: boolean }>(
    'get_tool_knowledge',
    {
      title: 'Get tool knowledge',
      description: 'Every VERIFIED claim about an API as structured records (latest version by default), paginated, spec divergences flagged, each with compact evidence (trial id, probe, status, request line). Use when you need to filter by kind or process claims programmatically; for the one-read summary before calling the API use get_tool_docs. verbose=true adds response previews.',
      inputSchema: { tool: TOOL_ARG, version: z.number().int().optional().describe('tool_version id; default latest'), kind: z.string().optional().describe('required | type | auth | pagination | error_behavior | response_shape | undocumented_constraint | undocumented | other'), limit: z.number().int().min(1).max(500).optional().describe('default 100'), offset: z.number().int().min(0).optional(), verbose: z.boolean().optional() },
    },
    async ({ tool, version, kind, limit, offset, verbose }) => {
      const ref = await resolveName(tool);
      if ('error' in ref) return ref.error;
      const k = await toolKnowledge(await getDb(), ref.name, version ?? null, false);
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
    { title: 'Get divergences', description: 'Where the live API CONTRADICTS its own OpenAPI spec: documented limits not enforced, types not validated, required params not required, enums that accept other values. Read before trusting a spec-generated client or SDK for this API. Compact evidence; verbose=true adds response previews.', inputSchema: { tool: TOOL_ARG, version: z.number().int().optional(), verbose: z.boolean().optional() } },
    async ({ tool, version, verbose }) => {
      const ref = await resolveName(tool);
      if ('error' in ref) return ref.error;
      const k = await toolKnowledge(await getDb(), ref.name, version ?? null, true);
      if (!k) return noSuchTool(tool);
      return text({ tool: k.tool, tier: k.tier, version: k.version, run_id: k.run_id, total: k.claims.length, claims: shape(k.claims, verbose) });
    },
  );

  tool<{ query: string; tool?: string; limit?: number; verbose?: boolean }>(
    'search_claims',
    { title: 'Search claims', description: 'Call this when an API call FAILED or behaved unexpectedly: an unexpected 4xx/5xx, a parameter that seems ignored, an odd page, wrong filter results. Full-text search over verified claims with the host and the symptom, e.g. "github per_page 500", "npm search size 0", "is latitude required on /v1/forecast". Optionally restrict to one API (name, host or URL). Compact evidence unless verbose=true.', inputSchema: { query: z.string(), tool: TOOL_ARG.optional(), limit: z.number().int().min(1).max(50).optional(), verbose: z.boolean().optional() } },
    async ({ query, tool, limit, verbose }) => {
      let name: string | null = null;
      if (tool) {
        const ref = await resolveName(tool);
        if ('error' in ref) return ref.error;
        name = ref.name;
      }
      return text(shape(await searchClaims(await getDb(), query, name, limit ?? 20), verbose));
    },
  );

  tool<{ tool: string; version?: number; brief?: boolean; path?: string }>(
    'get_tool_docs',
    { title: 'Get tool docs', description: 'READ THIS BEFORE YOUR FIRST CALL to an API the compendium covers. Pass the host or URL you are about to call (api.github.com, https://registry.npmjs.org/-/v1/search) or the tool name. Returns a Markdown behavior sheet built only from verified claims: where the API contradicts its spec first, then sibling differences, undocumented rules, and per-endpoint behavior (error shapes, pagination, validation, auth). Each line cites the trial ids that back it. One read; no need to repeat it in the same session. brief=true returns only spec divergences, undocumented rules, and auth / pagination / error behavior (about a third of the size). Pass the request path (or a full URL as tool) to get ONLY the endpoint you are about to call plus a one-line index of the others; descend to another by passing its path.', inputSchema: { tool: TOOL_ARG, version: z.number().int().optional(), brief: z.boolean().optional().describe('divergences, undocumented rules, auth, pagination and error behavior only'), path: z.string().optional().describe('request path to scope to one endpoint, e.g. /repos/github/rest-api-description/issues; template segments match anything') } },
    async ({ tool, version, brief, path }) => {
      const ref = await resolveName(tool);
      if ('error' in ref) return ref.error;
      const md = await renderToolDocs(await getDb(), ref.name, version ?? null, { brief: !!brief, path: path ?? pathOf(tool) });
      return md ? { content: [{ type: 'text' as const, text: md }] } : await noSuchTool(tool);
    },
  );

  tool<{ tool: string; from_version: number; to_version: number }>(
    'get_version_diff',
    { title: 'Get version diff', description: 'What changed in verified BEHAVIOR between two spec versions of an API (changed / added / removed claims), as opposed to what changed in the spec text. Version ids come from list_versions.', inputSchema: { tool: TOOL_ARG, from_version: z.number().int(), to_version: z.number().int() } },
    async ({ tool, from_version, to_version }) => {
      const ref = await resolveName(tool);
      if ('error' in ref) return ref.error;
      const d = await versionDiff(await getDb(), ref.name, from_version, to_version);
      return d ? text(d) : await noSuchTool(tool);
    },
  );

  tool<{ target: Record<string, unknown> }>(
    'request_target',
    {
      title: 'Request a target',
      description:
        'The API you are about to call is NOT covered (not in list_tools)? Ask the compendium to test it. Pass a target object: { name, spec_url (OpenAPI 3 document), category?, include_paths?, baseline? (valid values for required params per path), optional_values?, server? }. Scope: public read-only APIs with no credentials (no headers accepted). The request is validated now (spec fetched and parsed, battery planned) and processed rules-only on the worker\'s next pass; use get_request_status with the returned id. Requires a per-user key. Quota: 3 requests per key per day.',
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
  app.disable('x-powered-by');
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
  // Public API behavior does not need per-user identity to READ. Anonymous callers get the read
  // tools under a per-IP limit and a global daily cap; request_target and /contribute still need
  // a key. AUTOPIA_ANON_READS=0 restores key-only access.
  const anonReads = process.env.AUTOPIA_ANON_READS !== '0';
  const anon = new AnonLimiter(Number(process.env.AUTOPIA_ANON_PER_MINUTE ?? 60), Number(process.env.AUTOPIA_ANON_PER_DAY ?? 2000), Number(process.env.AUTOPIA_ANON_DAILY_CAP ?? 50_000));
  app.set('trust proxy', true); // Render / Fly terminate TLS; req.ip is then the client, not the proxy
  if (adminToken) log.info('mcp', 'admin token configured; per-user ak_ keys also accepted on /mcp');
  if (openEndpoint) log.warn('mcp', 'AUTOPIA_MCP_OPEN=1: /mcp accepts unauthenticated calls without limits');
  else if (anonReads) log.info('mcp', `anonymous reads on /mcp: ${anon.perMinute}/min and ${anon.perDay}/day per IP, ${anon.dailyCap}/day overall; keys for request_target and /contribute`);
  else log.info('mcp', 'AUTOPIA_ANON_READS=0: per-user ak_ keys required on /mcp');

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
    } else if (adminToken && sameSecret(presented, adminToken)) {
      ctx = { keyId: null, logCalls: true, identity: 'admin' };
    } else if (openEndpoint) {
      ctx = { keyId: null, logCalls: true, identity: 'open' };
    } else if (anonReads) {
      // No credential, or an unexpanded placeholder like "${user_config.autopia_key}": a reader.
      const verdict = anon.take(req.ip ?? 'unknown');
      if (!verdict.ok) {
        res.status(429).set('retry-after', String(verdict.retryAfterSeconds)).json({ error: verdict.reason, hint: 'A per-user key (Authorization: Bearer ak_...) has its own quota; see the README.' });
        return;
      }
      ctx = { keyId: null, logCalls: true, identity: 'anon' };
    } else {
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
    } else if (adminToken && sameSecret(presented, adminToken)) {
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
