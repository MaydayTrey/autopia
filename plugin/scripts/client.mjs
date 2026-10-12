/**
 * Shared plumbing for the Autopia hooks: configuration, the JSON-RPC call to the compendium
 * server, the host index cache, and per-session state. Plain Node, no dependencies.
 *
 * Configuration (first match wins):
 *   (no key: the hooks read anonymously, by design; the API key the user may configure is used
 *    only by the autopia MCP server entry in .mcp.json, never by these scripts)
 *   url   AUTOPIA_MCP_URL (self-hosted servers)                 |  hosted default
 *   data  CLAUDE_PLUGIN_DATA (durable plugin storage)            |  ~/.autopia
 *
 * State on disk (all under the data dir):
 *   hosts.json                 host -> tools, refreshed from list_tools every 24h
 *   sheets/<tool>.<path>.brief.md  scoped brief sheets, refreshed every 6h
 *   sessions/<session_id>.json what this session has already been shown
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostIndex, parseMcpBody, resultText } from './lib.mjs';

export const DEFAULT_URL = 'https://autopia-mcp.onrender.com/mcp';
const HOSTS_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

export const url = process.env.AUTOPIA_MCP_URL || DEFAULT_URL;
export const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.autopia');
export const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const debug = process.env.AUTOPIA_HOOK_DEBUG === '1' ? (m) => process.stderr.write(`[autopia-hook] ${m}\n`) : () => {};

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** One MCP tools/call over Streamable HTTP, returning the text content. Throws with "HTTP <status>" on a non-2xx. */
export async function rpc(name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return resultText(parseMcpBody(res.headers.get('content-type'), text));
}

/** host -> tools; live list cached 24h, stale cache if the server is unreachable, bundled snapshot as the last resort. */
export async function hosts() {
  const file = path.join(dataDir, 'hosts.json');
  const cached = readJson(file, null);
  if (cached && Date.now() - cached.fetched_at < HOSTS_TTL_MS) return cached.hosts;
  try {
    const idx = hostIndex(JSON.parse(await rpc('list_tools', {})));
    writeJson(file, { fetched_at: Date.now(), hosts: idx });
    return idx;
  } catch (e) {
    debug(`list_tools failed: ${e.message}`);
  }
  if (cached) return cached.hosts;
  return readJson(path.join(pluginRoot, 'hosts.json'), { hosts: {} }).hosts;
}

/** Per-session memory of what was already injected. */
export function session(sessionId) {
  const file = path.join(dataDir, 'sessions', `${String(sessionId || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const state = readJson(file, { injected: [], setup_noted: false });
  return {
    state,
    has: (k) => state.injected.includes(k),
    add: (...keys) => {
      state.injected = [...new Set([...state.injected, ...keys])];
      writeJson(file, state);
    },
    save: () => writeJson(file, state),
  };
}

/** Read the hook's stdin as JSON; null when it is not JSON (then the hook does nothing). */
export function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}
