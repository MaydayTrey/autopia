/**
 * Pure helpers for the Autopia PreToolUse hook. No I/O here, so the unit tests
 * can cover matching, trimming and protocol parsing without a server.
 *
 * Runs on plain Node (18+): no dependencies, no build step, because Claude Code
 * executes the hook straight from the plugin directory.
 */

/** The text to scan for API hosts, per tool. Null when the tool is not one we watch. */
export function candidateText(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  if (toolName === 'Bash') return typeof toolInput.command === 'string' ? toolInput.command : null;
  if (toolName === 'WebFetch') return typeof toolInput.url === 'string' ? toolInput.url : null;
  return null;
}

/**
 * Build host -> [tool names] from a list_tools response (each tool carries `hosts`).
 * Tools without hosts (never run, or parked) are left out.
 */
export function hostIndex(tools) {
  const idx = {};
  for (const t of Array.isArray(tools) ? tools : []) {
    for (const h of Array.isArray(t.hosts) ? t.hosts : []) {
      const host = String(h).toLowerCase();
      idx[host] = [...new Set([...(idx[host] ?? []), t.name])];
    }
  }
  return idx;
}

/**
 * Hosts from the index that the text mentions, as whole tokens: "api.github.com" matches in
 * "curl https://api.github.com/repos/x" and in "api.github.com/repos/x", not in "notapi.github.com".
 * A host that includes a port only matches with that port.
 */
export function matchHosts(text, index) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out = [];
  for (const host of Object.keys(index).sort((a, b) => b.length - a.length)) {
    const i = lower.indexOf(host);
    if (i === -1) continue;
    const re = new RegExp(`(^|[^a-z0-9.-])${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9.-])`);
    if (re.test(lower)) out.push({ host, tools: index[host] });
  }
  return out;
}

/**
 * Parse one Streamable-HTTP response to a JSON-RPC message: plain JSON, or SSE where the
 * last `data:` line carries the result.
 */
export function parseMcpBody(contentType, text) {
  if ((contentType ?? '').includes('text/event-stream')) {
    const data = text
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    if (!data.length) throw new Error('empty event stream');
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

/** The text of a tools/call result, or throw with the server's error. */
export function resultText(msg) {
  if (msg.error) throw new Error(`rpc error ${msg.error.code ?? ''}: ${msg.error.message ?? ''}`.trim());
  const text = msg.result?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error('no text content in result');
  if (msg.result.isError) throw new Error(text.slice(0, 200));
  return text;
}

/**
 * Keep a behavior sheet under `max` characters by cutting at a line boundary. The sheet is
 * ordered by value (spec contradictions, sibling differences, undocumented rules, common
 * behavior, then per endpoint), so the cut always drops the least important tail. Claude
 * Code spills additionalContext over 10,000 characters to a file with a short preview,
 * which would defeat the injection, hence the budget.
 */
export function trimSheet(md, max, toolName) {
  if (md.length <= max) return md;
  const note = `\n\n[Sheet truncated at ${max} characters. Full sheet: get_tool_docs {"tool":"${toolName}"}; one question: search_claims.]`;
  let cut = md.lastIndexOf('\n', max - note.length);
  if (cut < max / 2) cut = max - note.length;
  return md.slice(0, cut) + note;
}

/**
 * The additionalContext for one or more matched hosts. Several tools (open-meteo forecast and
 * elevation share a host) split the budget.
 */
export function buildContext(sheets, budget = 9500) {
  if (!sheets.length) return '';
  const header =
    'Autopia: VERIFIED behavior of the API this command is about to call, from the Discrimen Compendium. Every line was observed on the live API and reproduced; the bracketed numbers are trial ids. Read the "contradicts the spec" and "Rules the spec never states" sections before trusting the documentation. Injected once per host per session.';
  const per = Math.max(2000, Math.floor((budget - header.length) / sheets.length) - 80);
  const parts = sheets.map((s) => `--- ${s.host} -> ${s.tool} ---\n${trimSheet(s.markdown, per, s.tool)}`);
  return `${header}\n\n${parts.join('\n\n')}`;
}

/** The one-time note when a covered host is seen but no key is configured. */
export function setupContext(hosts) {
  const list = hosts.map((h) => h.host).join(', ');
  return (
    `Autopia: this command calls ${list}, an API with a verified behavior sheet in the Discrimen Compendium, but no Autopia key is configured so the sheet was not injected. ` +
    `Tell the user once: run \`claude plugin configure autopia\` and enter their Autopia API key (see the plugin README for how to get one). Then proceed with the command as planned.`
  );
}

/** Hook JSON for PreToolUse: context only, never a permission decision. */
export function hookOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
}
