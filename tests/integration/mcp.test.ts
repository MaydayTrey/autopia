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
  const missing = await mcp.callTool({ name: 'get_tool_docs', arguments: { tool: 'nope' } });
  assert.equal(missing.isError, true);
});

test('mcp: list_tools / list_versions', async () => {
  const tools = parse(await mcp.callTool({ name: 'list_tools', arguments: {} }));
  assert.equal(tools[0].name, 'mock-items');
  assert.equal(tools[0].versions, 2);
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
