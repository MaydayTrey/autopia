/**
 * Spawns the real MCP server (stdio) on a throwaway PGlite dir populated by one
 * pipeline run against the mock API, and exercises every tool through a real
 * MCP client. This is what "an agent can consult the compendium" means.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startMockApi, type MockApi } from '../mock-api/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let dir: string;
let api: MockApi;
let mcp: Client;
let transport: StdioClientTransport;
let versionIds: number[] = [];
let api2Host = ''; // the host the LATEST version's trials hit (second mock server)

function parse(res: { content: unknown }) {
  const block = (res.content as { type: string; text: string }[])[0];
  return JSON.parse(block.text);
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-mcp-'));
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  const client = await import('../../src/db/client.js');
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  api = await startMockApi('v1');
  const db = await client.getDb();
  const target = validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } });
  const s1 = await runPipeline(db, target, { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 4 });
  const api2 = await startMockApi('v2');
  api2Host = new URL(api2.url).host;
  const s2 = await runPipeline(db, { ...target, spec_url: api2.specPath }, { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 4 });
  await api2.close();
  versionIds = [s1.toolVersionId, s2.toolVersionId];
  await client.closeDb(); // PGlite: one process at a time; hand the dir to the server process

  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts')],
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', DATABASE_URL: '' } as Record<string, string>, // '' pins the child to PGlite even when .env has a real Postgres
    stderr: 'pipe',
  });
  mcp = new Client({ name: 'autopia-test-client', version: '0.0.0' });
  await mcp.connect(transport);
});

after(async () => {
  await mcp.close().catch(() => undefined);
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('mcp: lists the expected tools', async () => {
  const { tools } = await mcp.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['get_divergences', 'get_request_status', 'get_tool_docs', 'get_tool_knowledge', 'get_version_diff', 'list_tools', 'list_versions', 'request_target', 'search_claims']);
});

test('mcp: get_tool_docs returns a Markdown behavior sheet with divergences first and trial ids', async () => {
  const res = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'mock-items', version: versionIds[0] } });
  const md = (res.content as { type: string; text: string }[])[0].text;
  assert.match(md, /^# mock-items: verified behavior/);
  assert.match(md, /## Where behavior contradicts the spec \(\d+\)/);
  assert.match(md, /The spec marks "q" as required, but omitting it still returns HTTP 200/);
  assert.match(md, /### GET \/v1\/items/);
  assert.match(md, /Request validation:/);
  assert.match(md, /`limit`/);
  assert.match(md, /Responses:/);
  assert.match(md, /content-type/);
  assert.match(md, /\[#\d+(, #\d+)*\]/, 'every line cites trial ids');
  assert.ok(md.indexOf('## Where behavior contradicts the spec') < md.indexOf('## Endpoint behavior'), 'divergences come first');
  // brief=true: what the plugin hook injects. Divergences and watch-outs, no per-parameter validation or response shapes.
  const brief = (await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'mock-items', version: versionIds[0], brief: true } })).content as { text: string }[];
  assert.match(brief[0].text, /## Where behavior contradicts the spec/);
  assert.match(brief[0].text, /## Watch out for \(auth, pagination, errors\)/);
  assert.match(brief[0].text, /Full sheet .*: get_tool_docs \{"tool":"mock-items"\}/);
  assert.doesNotMatch(brief[0].text, /Request validation:/);
  assert.doesNotMatch(brief[0].text, /Responses:/);
  assert.ok(brief[0].text.length < md.length, `brief ${brief[0].text.length} vs full ${md.length}`); // the mock sheet is small; github goes from ~15KB to ~3KB
  // path: scope to the endpoint the request path matches; a full URL as `tool` scopes too.
  const scoped = (await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'mock-items', version: versionIds[0], path: '/v1/items?q=1' } })).content as { text: string }[];
  assert.match(scoped[0].text, /^# mock-items: verified behavior for GET \/v1\/items/);
  assert.match(scoped[0].text, /Request validation:/, 'the scoped full sheet still has the endpoint detail');
  const viaUrl = (await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: `${api.url}/v1/items?q=hello`, version: versionIds[0], brief: true } })).content as { text: string }[];
  assert.match(viaUrl[0].text, /^# mock-items: verified behavior for GET \/v1\/items/);
  assert.match(viaUrl[0].text, /## Watch out for \(auth, pagination, errors\) on GET \/v1\/items/);
  assert.match(viaUrl[0].text, /Full sheet for this endpoint .*"path":"\/v1\/items"/);
  const nomatch = (await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'mock-items', version: versionIds[0], path: '/nope/here' } })).content as { text: string }[];
  assert.match(nomatch[0].text, /No covered endpoint matches the path \/nope\/here/);
  assert.match(nomatch[0].text, /## Other endpoints covered \(\d+\)/);
  // The host / URL form: what an agent has in hand when it is about to call the API.
  const byHost = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: new URL(api.url).host, version: versionIds[0] } });
  assert.match((byHost.content as { text: string }[])[0].text, /^# mock-items: verified behavior/);
  const byUrl = parse(await mcp.callTool({ name: 'get_divergences', arguments: { tool: `${api.url}/v1/items?q=hello` } }));
  assert.equal(byUrl.tool, 'mock-items');
  const unknownHost = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'api.example.com' } });
  assert.equal(unknownHost.isError, true);
  assert.match((unknownHost.content as { text: string }[])[0].text, /no such tool: api.example.com/);
  const missing = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'nope' } });
  assert.equal(missing.isError, true);
});

test('mcp: the server ships an instructions block written for the moment of use', () => {
  const ins = mcp.getInstructions() ?? '';
  assert.match(ins, /BEFORE your first request/);
  assert.match(ins, /get_tool_docs/);
  assert.match(ins, /search_claims/);
  assert.match(ins, /SKIP:/);
});

test('mcp: list_tools / list_versions', async () => {
  const tools = parse(await mcp.callTool({ name: 'list_tools', arguments: {} }));
  assert.equal(tools[0].name, 'mock-items');
  assert.equal(tools[0].versions, 2);
  assert.deepEqual(tools[0].hosts, [api2Host], 'the host the latest run hit, so an agent can match the URL it is about to call');
  const versions = parse(await mcp.callTool({ name: 'list_versions', arguments: { tool: 'mock-items' } }));
  assert.deepEqual(versions.map((v: { id: number }) => v.id).sort(), [...versionIds].sort());
});

test('mcp: get_tool_knowledge is paginated with compact evidence; get_divergences only divergences; verbose adds previews', async () => {
  const k = parse(await mcp.callTool({ name: 'get_tool_knowledge', arguments: { tool: 'mock-items', version: versionIds[0], limit: 5 } }));
  assert.equal(k.returned, 5);
  assert.ok(k.total > 10);
  assert.equal(k.claims.length, 5);
  assert.ok(k.counts_by_kind.error_behavior >= 1);
  for (const c of k.claims as { verified: boolean; evidence: Record<string, unknown>[] }[]) {
    assert.ok(c.verified && c.evidence.length >= 1);
    for (const e of c.evidence) {
      assert.deepEqual(Object.keys(e).sort(), ['id', 'param', 'probe', 'request', 'status'], 'compact evidence: no bodies, no header maps');
      assert.match(String(e.request), /^GET http/);
    }
  }
  const page2 = parse(await mcp.callTool({ name: 'get_tool_knowledge', arguments: { tool: 'mock-items', version: versionIds[0], limit: 5, offset: 5 } }));
  assert.notDeepEqual(page2.claims.map((c: { id: number }) => c.id), k.claims.map((c: { id: number }) => c.id));
  const onlyAuth = parse(await mcp.callTool({ name: 'get_tool_knowledge', arguments: { tool: 'mock-items', version: versionIds[0], kind: 'error_behavior' } }));
  assert.ok(onlyAuth.claims.every((c: { kind: string }) => c.kind === 'error_behavior'));

  const d = parse(await mcp.callTool({ name: 'get_divergences', arguments: { tool: 'mock-items', version: versionIds[0] } }));
  assert.ok(d.claims.length >= 3);
  assert.ok(d.claims.every((c: { diverges_from_spec: boolean }) => c.diverges_from_spec));
  assert.ok(d.claims.some((c: { claim_key: string }) => c.claim_key === 'rule:required_omitted:get_v1_items:q'));
  const compactSize = JSON.stringify(d).length;
  const v = parse(await mcp.callTool({ name: 'get_divergences', arguments: { tool: 'mock-items', version: versionIds[0], verbose: true } }));
  assert.ok('response_preview' in v.claims[0].evidence[0], 'verbose carries previews');
  assert.ok(JSON.stringify(v).length > compactSize, 'and is larger');
});

test('mcp: an unknown tool name gets a suggestion', async () => {
  const res = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'mock' } });
  assert.equal(res.isError, true);
  assert.match((res.content as { text: string }[])[0].text, /Did you mean \\"mock-items\\"/);
});

test('mcp: search_claims answers a usage question', async () => {
  const hits = parse(await mcp.callTool({ name: 'search_claims', arguments: { query: 'is q required on /v1/items', tool: 'mock-items' } }));
  assert.ok(Array.isArray(hits) && hits.length >= 1);
  assert.ok(hits.some((h: { param: string | null }) => h.param === 'q'));
});

test('mcp: get_version_diff shows the changelog', async () => {
  const d = parse(await mcp.callTool({ name: 'get_version_diff', arguments: { tool: 'mock-items', from_version: versionIds[0], to_version: versionIds[1] } }));
  assert.ok(d.counts.changed >= 3);
  assert.ok(d.changes.some((c: { claim_key: string; change: string }) => c.claim_key === 'rule:required_omitted:get_v1_items:q' && c.change === 'changed'));
});

test('mcp: unknown tool is an error result, not a crash', async () => {
  const res = await mcp.callTool({ name: 'get_tool_knowledge', arguments: { tool: 'nope' } });
  assert.equal(res.isError, true);
});
