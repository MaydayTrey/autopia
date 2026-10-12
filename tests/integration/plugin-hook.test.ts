/**
 * Runs the plugin's PreToolUse hook script as Claude Code would (JSON on stdin, JSON on
 * stdout) against a real HTTP MCP server on a throwaway PGlite dir, so the whole chain is
 * exercised: host matching -> list_tools -> get_tool_docs -> additionalContext, once per
 * session, failing open when the server is gone.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi, type MockApi } from '../mock-api/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOOK = path.join(ROOT, 'plugin', 'scripts', 'autopia-hook.mjs');
let dir: string;
let dataDir: string;
let api: MockApi;
let child: ChildProcess;
let port: number;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a !== 'string' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

async function waitFor(url: string, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not come up at ${url}`);
}

/** Run the hook as Claude Code does. Returns stdout parsed (or null when the hook printed nothing) and stderr. */
function runHook(input: Record<string, unknown>, env: Record<string, string>): Promise<{ out: { hookSpecificOutput: { hookEventName: string; additionalContext: string } } | null; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, AUTOPIA_HOOK_DEBUG: '1', CLAUDE_PLUGIN_DATA: dataDir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (code) => resolve({ out: stdout.trim() ? JSON.parse(stdout) : null, err: stderr, code }));
    p.stdin.end(JSON.stringify(input));
  });
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'autopia-hook-'));
  dataDir = path.join(dir, 'plugin-data');
  process.env.PGLITE_DIR = dir;
  delete process.env.DATABASE_URL;
  process.env.AUTOPIA_LOG = process.env.AUTOPIA_LOG ?? 'warn';
  const client = await import('../../src/db/client.js');
  const { runPipeline } = await import('../../src/worker/pipeline.js');
  const { validateTarget } = await import('../../src/worker/target.js');
  api = await startMockApi('v1');
  const db = await client.getDb();
  await runPipeline(db, validateTarget({ name: 'mock-items', spec_url: api.specPath, baseline: { '/v1/items': { q: 'hello' } } }), { llm: null, sleep: async () => {}, minIntervalMs: 0, concurrency: 4 });
  await client.closeDb();

  port = await freePort();
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(ROOT, 'src', 'server', 'mcp.ts'), '--http', String(port)], {
    env: { ...process.env, PGLITE_DIR: dir, AUTOPIA_LOG: 'error', DATABASE_URL: '', AUTOPIA_MCP_TOKEN: '', AUTOPIA_MCP_OPEN: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitFor(`http://127.0.0.1:${port}/healthz`, 30_000);
});

after(async () => {
  child.kill();
  await new Promise((r) => child.once('exit', r));
  await api.close();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

test('hook: a Bash command that calls a covered host gets the behavior sheet injected, once per session', async () => {
  const env = { AUTOPIA_MCP_URL: `http://127.0.0.1:${port}/mcp`, AUTOPIA_API_KEY: '' }; // open endpoint: an explicit server URL is enough, no key
  const host = new URL(api.url).host;
  const first = await runHook({ session_id: 's1', tool_name: 'Bash', tool_input: { command: `curl -s "http://${host}/v1/items?q=hello&limit=0"` } }, env);
  assert.equal(first.code, 0);
  assert.ok(first.out, `expected output, stderr: ${first.err}`);
  const ctx = first.out!.hookSpecificOutput.additionalContext;
  assert.equal(first.out!.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(ctx, /^Autopia: VERIFIED behavior/);
  assert.match(ctx, new RegExp(`--- ${host.replace('.', '\\.')} -> mock-items ---`));
  assert.match(ctx, /# mock-items: verified behavior/);
  assert.match(ctx, /Where behavior contradicts the spec/);
  assert.match(ctx, /Watch out for \(auth, pagination, errors\)/, 'the hook asks for the brief sheet');
  assert.doesNotMatch(ctx, /Request validation:/, 'per-parameter validation is not injected');
  assert.ok(ctx.length < 5_100, `length ${ctx.length}`);

  // Caches were written: host index and the sheet.
  const hosts = JSON.parse(await readFile(path.join(dataDir, 'hosts.json'), 'utf8'));
  assert.deepEqual(hosts.hosts[host], ['mock-items']);
  assert.match(await readFile(path.join(dataDir, 'sheets', 'mock-items.brief.md'), 'utf8'), /^# mock-items/);

  const second = await runHook({ session_id: 's1', tool_name: 'Bash', tool_input: { command: `curl http://${host}/v1/items?q=x` } }, env);
  assert.equal(second.out, null, 'same session, same host: nothing injected again');
  assert.match(second.err, /already injected this session/);

  const other = await runHook({ session_id: 's2', tool_name: 'WebFetch', tool_input: { url: `http://${host}/v1/items?q=hello`, prompt: 'x' } }, env);
  assert.ok(other.out, 'a new session gets it again, through the WebFetch url form');
  assert.match(other.out!.hookSpecificOutput.additionalContext, /# mock-items/);
});

test('hook: unrelated commands, unknown hosts and missing keys produce no injection; a missing key notes setup once', async () => {
  const env = { AUTOPIA_MCP_URL: `http://127.0.0.1:${port}/mcp`, AUTOPIA_API_KEY: '' };
  const host = new URL(api.url).host;
  assert.equal((await runHook({ session_id: 's3', tool_name: 'Bash', tool_input: { command: 'git status && npm test' } }, env)).out, null);
  assert.equal((await runHook({ session_id: 's3', tool_name: 'Bash', tool_input: { command: 'curl https://example.com/api' } }, env)).out, null);
  assert.equal((await runHook({ session_id: 's3', tool_name: 'Read', tool_input: { file_path: `${host}.txt` } }, env)).out, null);

  const noKey = { AUTOPIA_MCP_URL: '', AUTOPIA_API_KEY: '', CLAUDE_PLUGIN_OPTION_AUTOPIA_KEY: '' }; // hosted default URL, no key: the setup note, served from the cached host list without a network call
  const note = await runHook({ session_id: 's4', tool_name: 'Bash', tool_input: { command: `curl http://${host}/v1/items` } }, noKey);
  assert.ok(note.out, 'the cached host list from the previous test still identifies the host');
  assert.match(note.out!.hookSpecificOutput.additionalContext, /no Autopia key is configured/);
  assert.match(note.out!.hookSpecificOutput.additionalContext, /claude plugin configure autopia/);
  const again = await runHook({ session_id: 's4', tool_name: 'Bash', tool_input: { command: `curl http://${host}/v1/items` } }, noKey);
  assert.equal(again.out, null, 'the setup note is given once per session');
});

test('hook: fails open when the server is unreachable (nothing printed, exit 0, under the timeout)', async () => {
  const dead = await freePort();
  const host = new URL(api.url).host;
  await rm(path.join(dataDir, 'sheets'), { recursive: true, force: true }); // force a fetch
  const t0 = Date.now();
  const r = await runHook({ session_id: 's5', tool_name: 'Bash', tool_input: { command: `curl http://${host}/v1/items` } }, { AUTOPIA_MCP_URL: `http://127.0.0.1:${dead}/mcp`, AUTOPIA_API_KEY: '' });
  assert.equal(r.code, 0);
  assert.equal(r.out, null);
  assert.match(r.err, /sheet mock-items failed/);
  assert.ok(Date.now() - t0 < 10_000);
  // Malformed stdin is also harmless.
  const bad = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const p = spawn(process.execPath, [HOOK], { env: { ...process.env, CLAUDE_PLUGIN_DATA: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.on('close', (code) => resolve({ code, stdout }));
    p.stdin.end('not json');
  });
  assert.equal(bad.code, 0);
  assert.equal(bad.stdout, '');
});
