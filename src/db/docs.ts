/**
 * Render a tool's verified behavior as a Markdown "behavior sheet": the
 * documentation an agent actually wants, generated from evidence rather than
 * written by hand. Served by the MCP tool get_tool_docs, the CLI `docs`
 * command, and the dashboard.
 *
 * Order: divergences from the spec first (the money view), then differences
 * from sibling tools, then every endpoint's verified behavior grouped by
 * parameter. Every line ends with the trial ids that back it.
 */
import type { Db } from './client.js';
import { toolKnowledge, type ClaimView } from './queries.js';

export async function renderToolDocs(db: Db, toolName: string, versionId?: number | null): Promise<string | null> {
  const k = await toolKnowledge(db, toolName, versionId ?? null, false);
  if (!k) return null;
  const lines: string[] = [];
  const claims = k.claims;
  const ev = (c: ClaimView) => `[${c.evidence.map((e) => `#${e.id}`).join(', ')}]`;

  lines.push(`# ${k.tool}: verified behavior`);
  if (!k.version) {
    lines.push('', 'No versions recorded yet.');
    return lines.join('\n');
  }
  lines.push('', `Spec: ${k.version.spec_url}`, `Version: ${k.version.label ?? 'unlabeled'} (spec hash ${k.version.spec_hash.slice(0, 12)}), discovered ${new Date(k.version.discovered_at).toISOString().slice(0, 10)}`, `Verified claims: ${claims.length} from run #${k.run_id ?? '-'}. Every claim below reproduced when re-run; numbers in brackets are the trial ids that back it.`);

  const spec = claims.filter((c) => c.divergence_type === 'spec');
  lines.push('', `## Where behavior contradicts the spec (${spec.length})`);
  if (spec.length === 0) lines.push('', 'None found.');
  for (const c of spec) lines.push('', `- **${c.endpoint}** ${c.statement} Spec says: ${c.spec_says ?? 'n/a'}. ${ev(c)}`);

  const sib = claims.filter((c) => c.sibling_note);
  lines.push('', `## Where this tool differs from sibling tools (${sib.length})`);
  if (sib.length === 0) lines.push('', 'No sibling disagreements recorded.');
  for (const c of sib) lines.push('', `- **${c.endpoint}** ${c.statement} Siblings: ${c.sibling_note}. ${ev(c)}`);

  const constraints = claims.filter((c) => c.kind === 'undocumented_constraint');
  if (constraints.length) {
    lines.push('', `## Rules the spec never states (${constraints.length})`);
    for (const c of constraints) lines.push('', `- **${c.endpoint}** ${c.statement} ${ev(c)}`);
  }

  const endpoints = [...new Set(claims.map((c) => c.endpoint))].sort();
  lines.push('', '## Endpoint behavior');
  for (const ep of endpoints) {
    const mine = claims.filter((c) => c.endpoint === ep && c.divergence_type !== 'spec' && c.kind !== 'undocumented_constraint');
    lines.push('', `### ${ep}`);
    const byParam = new Map<string, ClaimView[]>();
    for (const c of mine) byParam.set(c.param ?? '', [...(byParam.get(c.param ?? '') ?? []), c]);
    const general = byParam.get('') ?? [];
    if (general.length) {
      lines.push('', 'General:');
      for (const c of general.sort(byKind)) lines.push(`- ${c.statement} ${ev(c)}`);
    }
    for (const [param, list] of [...byParam.entries()].filter(([p]) => p).sort()) {
      lines.push('', `Parameter \`${param}\`:`);
      for (const c of list.sort(byKind)) lines.push(`- ${c.statement} ${ev(c)}`);
    }
  }
  return lines.join('\n');
}

const KIND_ORDER = ['required', 'auth', 'type', 'pagination', 'error_behavior', 'undocumented', 'other'];
function byKind(a: ClaimView, b: ClaimView): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.claim_key.localeCompare(b.claim_key);
}
