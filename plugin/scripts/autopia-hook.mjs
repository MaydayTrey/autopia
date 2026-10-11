#!/usr/bin/env node
/**
 * Autopia PreToolUse hook: when Bash or WebFetch is about to touch a host the compendium
 * covers, inject that API's verified behavior sheet into the model's context.
 *
 * Contract with Claude Code: JSON on stdin, JSON on stdout, exit 0. This hook never blocks
 * a call: every failure path (no key, server cold, timeout, bad JSON) prints nothing and
 * exits 0. Set AUTOPIA_HOOK_DEBUG=1 to see why on stderr.
 *
 * Configuration (first match wins):
 *   key   CLAUDE_PLUGIN_OPTION_AUTOPIA_KEY (plugin user config)  |  AUTOPIA_API_KEY
 *   url   CLAUDE_PLUGIN_OPTION_AUTOPIA_URL                       |  AUTOPIA_MCP_URL  |  hosted default
 *   data  CLAUDE_PLUGIN_DATA (durable plugin storage)            |  ~/.autopia
 *
 * State on disk (all under the data dir):
 *   hosts.json                 host -> tools, refreshed from list_tools every 24h
 *   sheets/<tool>.md           behavior sheets, refreshed every 6h
 *   sessions/<session_id>.json hosts already injected in this session (once per host)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext, candidateText, hookOutput, hostIndex, matchHosts, parseMcpBody, resultText, setupContext } from './lib.mjs';

const DEFAULT_URL = 'https://autopia-mcp.onrender.com/mcp';
const HOSTS_TTL_MS = 24 * 60 * 60 * 1000;
const SHEET_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const debug = process.env.AUTOPIA_HOOK_DEBUG === '1' ? (m) => process.stderr.write(`[autopia-hook] ${m}\n`) : () => {};

const key = process.env.CLAUDE_PLUGIN_OPTION_AUTOPIA_KEY || process.env.AUTOPIA_API_KEY || '';
const url = process.env.CLAUDE_PLUGIN_OPTION_AUTOPIA_URL || process.env.AUTOPIA_MCP_URL || DEFAULT_URL;
const dataDir = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.autopia');
/** A key, or an explicitly configured server (self-hosted or open endpoint), is what lets the hook call the server. */
const canCall = !!key || url !== DEFAULT_URL;
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

async function rpc(name, args) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return resultText(parseMcpBody(res.headers.get('content-type'), text));
}

/** host -> tools; live list cached 24h, stale cache if the server is unreachable, bundled snapshot as the last resort. */
async function hosts() {
  const file = path.join(dataDir, 'hosts.json');
  const cached = readJson(file, null);
  if (cached && Date.now() - cached.fetched_at < HOSTS_TTL_MS) return cached.hosts;
  if (canCall) {
    try {
      const idx = hostIndex(JSON.parse(await rpc('list_tools', {})));
      writeJson(file, { fetched_at: Date.now(), hosts: idx });
      return idx;
    } catch (e) {
      debug(`list_tools failed: ${e.message}`);
    }
  }
  if (cached) return cached.hosts;
  return readJson(path.join(pluginRoot, 'hosts.json'), { hosts: {} }).hosts;
}

async function sheet(tool) {
  const file = path.join(dataDir, 'sheets', `${tool}.md`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < SHEET_TTL_MS) return fs.readFileSync(file, 'utf8');
  } catch {
    /* not cached */
  }
  const md = await rpc('get_tool_docs', { tool });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md);
  return md;
}

async function main() {
  const raw = fs.readFileSync(0, 'utf8');
  const input = JSON.parse(raw);
  const text = candidateText(input.tool_name, input.tool_input);
  if (!text) return;
  const matches = matchHosts(text, await hosts());
  if (!matches.length) return;

  const sessionFile = path.join(dataDir, 'sessions', `${String(input.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  const state = readJson(sessionFile, { injected: [], setup_noted: false });
  const fresh = matches.filter((m) => !state.injected.includes(m.host));
  if (!fresh.length) {
    debug(`already injected this session: ${matches.map((m) => m.host).join(', ')}`);
    return;
  }

  if (!canCall) {
    if (state.setup_noted) return;
    state.setup_noted = true;
    writeJson(sessionFile, state);
    process.stdout.write(JSON.stringify(hookOutput(setupContext(fresh))));
    return;
  }

  const sheets = [];
  for (const m of fresh) {
    for (const tool of m.tools) {
      try {
        sheets.push({ host: m.host, tool, markdown: await sheet(tool) });
      } catch (e) {
        debug(`sheet ${tool} failed: ${e.message}`);
      }
    }
  }
  if (!sheets.length) return; // server cold or down: say nothing, try again on the next call
  state.injected.push(...new Set(sheets.map((s) => s.host)));
  writeJson(sessionFile, state);
  process.stdout.write(JSON.stringify(hookOutput(buildContext(sheets))));
}

main().catch((e) => debug(`failed open: ${e.message}`));
