#!/usr/bin/env node
/**
 * Autopia PreToolUse hook: when Bash or WebFetch is about to touch a host the compendium
 * covers, inject the verified behavior sheet for the endpoint in that URL.
 *
 * Contract with Claude Code: JSON on stdin, JSON on stdout, exit 0. This hook never blocks
 * a call: every failure path (server cold, timeout, bad JSON) prints nothing and exits 0. Reads
 * are anonymous on the hosted server, so no key is needed; a key raises the quota. Set
 * AUTOPIA_HOOK_DEBUG=1 to see decisions on stderr. Configuration and state: see client.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildContext, candidateText, hookOutput, matchHosts, setupContext, sheetEndpoint, urlPathFor } from './lib.mjs';
import { dataDir, debug, hosts, key, readInput, rpc, session } from './client.mjs';

const SHEET_TTL_MS = 6 * 60 * 60 * 1000;

/** The brief sheet scoped to a request path, cached per (tool, path). Older servers ignore unknown args and return the full sheet; trimSheet still bounds it. */
async function sheet(tool, reqPath) {
  const slug = reqPath ? createHash('sha1').update(reqPath).digest('hex').slice(0, 12) : 'all';
  const file = path.join(dataDir, 'sheets', `${tool}.${slug}.brief.md`);
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < SHEET_TTL_MS) return fs.readFileSync(file, 'utf8');
  } catch {
    /* not cached */
  }
  const md = await rpc('get_tool_docs', { tool, brief: true, ...(reqPath ? { path: reqPath } : {}) });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, md);
  return md;
}

async function main() {
  const input = readInput();
  if (!input) return;
  const text = candidateText(input.tool_name, input.tool_input);
  if (!text) return;
  const matches = matchHosts(text, await hosts());
  if (!matches.length) return;

  // Once per host + endpoint per session: the sheet is scoped to the endpoint in the URL, so a
  // second endpoint on the same host earns its own (small) injection; the same endpoint never twice.
  const s = session(input.session_id);
  const wanted = matches.map((m) => ({ ...m, path: urlPathFor(text, m.host) })).filter((m) => !s.has(`${m.host}|${m.path ?? '*'}`));
  if (!wanted.length) {
    debug(`already injected this session: ${matches.map((m) => m.host).join(', ')}`);
    return;
  }

  const sheets = [];
  let unauthorized = false;
  for (const m of wanted) {
    for (const tool of m.tools) {
      try {
        const markdown = await sheet(tool, m.path);
        const endpoint = sheetEndpoint(markdown);
        if (endpoint && s.has(`${m.host}|${endpoint}`)) {
          debug(`already injected ${endpoint} this session (different concrete path)`);
          continue;
        }
        sheets.push({ host: m.host, path: m.path, tool, endpoint, markdown });
      } catch (e) {
        if (/HTTP 401/.test(e.message)) unauthorized = true;
        debug(`sheet ${tool} failed: ${e.message}`);
      }
    }
  }
  if (!sheets.length) {
    // Server cold or down: say nothing, try again on the next call. Server refusing anonymous
    // reads and no key configured: say so, once per session.
    if (unauthorized && !key && !s.state.setup_noted) {
      s.state.setup_noted = true;
      s.save();
      process.stdout.write(JSON.stringify(hookOutput(setupContext(wanted))));
    }
    return;
  }
  s.add(...sheets.flatMap((x) => [`${x.host}|${x.path ?? '*'}`, ...(x.endpoint ? [`${x.host}|${x.endpoint}`] : [])]));
  process.stdout.write(JSON.stringify(hookOutput(buildContext(sheets))));
}

main().catch((e) => debug(`failed open: ${e.message}`));
