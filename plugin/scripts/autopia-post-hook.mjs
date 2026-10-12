#!/usr/bin/env node
/**
 * Autopia PostToolUse hook, the ERROR PATH: when a Bash or WebFetch call to a covered host
 * came back with a 4xx/5xx, inject the compendium's verified claims that match the failure.
 * The agent is already stuck and motivated, so this is where a few hundred tokens are worth
 * the most. Once per host + status + message per session. Never blocks; fails open.
 */
import { buildErrorContext, detectFailure, hookOutput } from './lib.mjs';
import { debug, hosts, readInput, rpc, session } from './client.mjs';

async function main() {
  const input = readInput();
  if (!input) return;
  const failure = detectFailure(input.tool_name, input.tool_input, input.tool_response, await hosts());
  if (!failure) return;
  const s = session(input.session_id);
  const k = `err|${failure.host}|${failure.status}|${(failure.message ?? '').toLowerCase().slice(0, 60)}`;
  if (s.has(k)) {
    debug(`already handled this failure in this session: ${k}`);
    return;
  }
  // The host narrows the search to the right tool; the message (or the status and path) is the query.
  const query = [failure.message, failure.path?.split('/').filter(Boolean).slice(-1)[0], `HTTP ${failure.status}`].filter(Boolean).join(' ');
  let claims = [];
  try {
    claims = JSON.parse(await rpc('search_claims', { query, tool: failure.host, limit: 5 }));
  } catch (e) {
    debug(`search_claims failed: ${e.message}`);
    return;
  }
  if (!Array.isArray(claims) || !claims.length) {
    debug(`no claims matched "${query}"`);
    return;
  }
  s.add(k);
  process.stdout.write(JSON.stringify(hookOutput(buildErrorContext(failure, claims), 'PostToolUse')));
}

main().catch((e) => debug(`failed open: ${e.message}`));
