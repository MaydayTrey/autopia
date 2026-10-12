/**
 * Render a tool's verified behavior as a Markdown "behavior sheet": the
 * documentation an agent actually wants, generated from evidence rather than
 * written by hand. Served by the MCP tool get_tool_docs, the CLI `docs`
 * command, and the dashboard.
 *
 * Order: divergences from the spec first (the money view), then differences
 * from sibling tools, undocumented rules, then per endpoint: what responses
 * look like, general behavior, and request validation COLLAPSED: one line per
 * parameter listing which probe values it rejects and accepts, and a single
 * summary line for the endpoint when every parameter behaves the same way.
 * Every line ends with the trial ids that back it.
 */
import type { Db } from './client.js';
import { toolKnowledge, type ClaimView } from './queries.js';

/** Inline evidence: the first few trial ids, then a count. 38 ids on one line is noise at the moment of use; get_tool_knowledge has them all. */
const EVIDENCE_INLINE_MAX = 8;
export function formatEvidence(c: ClaimView | ClaimView[], max = EVIDENCE_INLINE_MAX): string {
  const ids = (Array.isArray(c) ? c : [c]).flatMap((x) => x.evidence.map((e) => `#${e.id}`)).filter((v, i, a) => a.indexOf(v) === i);
  const shown = ids.slice(0, max);
  return `[${shown.join(', ')}${ids.length > max ? `, +${ids.length - max} more` : ''}]`;
}
const ev = formatEvidence;

/** Human label for a validation probe, from the rule name in the claim key. */
const PROBE_LABEL: Record<string, string> = {
  wrong_type: 'a wrong-type value ("abc")',
  enum_invalid: 'a value outside the documented enum',
  null_value: 'the literal "null"',
  empty_value: 'an empty value',
  boundary_zero: '0',
  boundary_negative: '-1',
  boundary_max_int: '2147483648',
  boundary_below_min: 'a value below the documented minimum',
  boundary_above_max: 'a value just above the documented maximum',
  boundary_far_above_max: 'a value far above the documented maximum',
  boundary_long_string: 'a 2048-character string',
  duplicate_param: 'the parameter twice',
  pagination_zero: '0',
  pagination_huge: '100000',
  pagination_beyond: '999999999',
};
const VALIDATION_RULES = new Set(Object.keys(PROBE_LABEL));
/** Boundary probes whose value depends on the spec: show the value actually sent when the probe trial recorded it. */
const SPEC_RELATIVE: Record<string, string> = {
  boundary_below_min: 'below the documented minimum',
  boundary_above_max: 'just above the documented maximum',
  boundary_far_above_max: 'far above the documented maximum',
};
function probeLabel(rule: string, c: ClaimView): string {
  const rel = SPEC_RELATIVE[rule];
  if (!rel || !c.param) return PROBE_LABEL[rule];
  const probe = c.evidence[c.evidence.length - 1];
  const sent = probe?.request?.query?.find(([k]) => k === c.param)?.[1];
  return sent === undefined || sent === '' ? PROBE_LABEL[rule] : `${sent} (${rel})`;
}

function ruleOf(c: ClaimView): string | null {
  const m = c.claim_key.match(/^rule:([^:]+):/);
  return m ? m[1] : null;
}

/** The status the PROBE trial showed (the last expectation; the first is the comparison base). */
function probeStatus(c: ClaimView): number | null {
  const last = c.evidence[c.evidence.length - 1];
  return last ? last.status : null;
}

export interface ParamSummary {
  param: string;
  rejects: { label: string; status: number | null; claim: ClaimView }[];
  accepts: { label: string; status: number | null; claim: ClaimView }[];
  observes: ClaimView[];
}

/**
 * Collapse per-probe validation claims into one summary per parameter.
 * Pure, so it can be unit tested without a database.
 */
export function summarizeParameters(claims: ClaimView[]): ParamSummary[] {
  const by = new Map<string, ParamSummary>();
  for (const c of claims) {
    if (!c.param) continue;
    const rule = ruleOf(c);
    const s = by.get(c.param) ?? { param: c.param, rejects: [], accepts: [], observes: [] };
    by.set(c.param, s);
    if (rule && VALIDATION_RULES.has(rule)) {
      const item = { label: probeLabel(rule, c), status: probeStatus(c), claim: c };
      if (c.verdict === 'rejects') s.rejects.push(item);
      else if (c.verdict === 'accepts') s.accepts.push(item);
      else s.observes.push(c);
    } else {
      s.observes.push(c);
    }
  }
  return [...by.values()].sort((a, b) => a.param.localeCompare(b.param));
}

function statusGroups(items: ParamSummary['rejects']): string {
  const g = new Map<string, { labels: string[]; claims: ClaimView[] }>();
  for (const it of items) {
    const k = it.status === null ? 'no response' : `HTTP ${it.status}`;
    const cur = g.get(k) ?? { labels: [], claims: [] };
    // boundary_zero and pagination_zero both read "0"; a spec-relative probe may have sent the same value as a fixed one ("0 (below the documented minimum)").
    const value = (l: string) => l.replace(/ \(.*\)$/, '');
    if (!cur.labels.some((l) => value(l) === value(it.label))) cur.labels.push(it.label);
    cur.claims.push(it.claim);
    g.set(k, cur);
  }
  return [...g.entries()].map(([status, v]) => `${v.labels.join(', ')} (${status}) ${ev(v.claims)}`).join('; ');
}

/** One line per parameter, or one summary line when every parameter rejects everything / accepts everything. */
export function renderParameterLines(summaries: ParamSummary[]): string[] {
  const lines: string[] = [];
  const validated = summaries.filter((s) => s.rejects.length + s.accepts.length > 0);
  const allReject = validated.filter((s) => s.accepts.length === 0);
  const allAccept = validated.filter((s) => s.rejects.length === 0);
  const mixed = validated.filter((s) => s.rejects.length > 0 && s.accepts.length > 0);

  if (validated.length >= 3 && allReject.length === validated.length) {
    const statuses = [...new Set(validated.flatMap((s) => s.rejects.map((r) => (r.status === null ? 'no response' : `HTTP ${r.status}`))))].join('/');
    lines.push(`- All ${validated.length} probed parameters (${validated.map((s) => `\`${s.param}\``).join(', ')}) reject every invalid value tried (wrong type, null, empty, out of range, duplicates) with ${statuses}. ${ev(validated.flatMap((s) => s.rejects.map((r) => r.claim)))}`);
  } else if (validated.length >= 3 && allAccept.length === validated.length) {
    lines.push(`- All ${validated.length} probed parameters (${validated.map((s) => `\`${s.param}\``).join(', ')}) accept every invalid value tried without an error; the API does not validate them. ${ev(validated.flatMap((s) => s.accepts.map((r) => r.claim)))}`);
  } else {
    // Uniform ones get one line each but compact; mixed ones are spelled out.
    if (validated.length >= 3 && allReject.length >= 2) {
      const statuses = [...new Set(allReject.flatMap((s) => s.rejects.map((r) => (r.status === null ? 'no response' : `HTTP ${r.status}`))))].join('/');
      lines.push(`- ${allReject.map((s) => `\`${s.param}\``).join(', ')} reject every invalid value tried with ${statuses}. ${ev(allReject.flatMap((s) => s.rejects.map((r) => r.claim)))}`);
    } else {
      for (const s of allReject) lines.push(`- \`${s.param}\` rejects ${statusGroups(s.rejects)}.`);
    }
    if (validated.length >= 3 && allAccept.length >= 2) {
      lines.push(`- ${allAccept.map((s) => `\`${s.param}\``).join(', ')} accept every invalid value tried without an error. ${ev(allAccept.flatMap((s) => s.accepts.map((r) => r.claim)))}`);
    } else {
      for (const s of allAccept) lines.push(`- \`${s.param}\` accepts ${statusGroups(s.accepts)}.`);
    }
    for (const s of mixed) lines.push(`- \`${s.param}\` rejects ${statusGroups(s.rejects)}; but accepts ${statusGroups(s.accepts)}.`);
  }
  for (const s of summaries) for (const c of s.observes) lines.push(`- \`${s.param}\`: ${c.statement} ${ev(c)}`);
  return lines;
}

export async function renderToolDocs(db: Db, toolName: string, versionId?: number | null): Promise<string | null> {
  const k = await toolKnowledge(db, toolName, versionId ?? null, false);
  if (!k) return null;
  const lines: string[] = [];
  const claims = k.claims;

  lines.push(`# ${k.tool}: verified behavior`);
  if (!k.version) {
    lines.push('', 'No versions recorded yet.');
    return lines.join('\n');
  }
  lines.push('', `Spec: ${k.version.spec_url}`, `Version: ${k.version.label ?? 'unlabeled'} (spec hash ${k.version.spec_hash.slice(0, 12)}), discovered ${new Date(k.version.discovered_at).toISOString().slice(0, 10)}`);
  if (k.tier === 'contributor') {
    const who = [...new Set(claims.map((c) => c.verified_by))].join(', ') || 'a contributor';
    const when = claims.length ? new Date(Math.max(...claims.map((c) => new Date(c.verified_at).getTime()))).toISOString().slice(0, 10) : 'unknown';
    lines.push(
      '',
      `> **Trust tier: contributor-verified.** This API needs credentials, so this server could not run it. The claims below were produced and reproduced by ${who} on ${when}, on their machine with their key, and have NOT been re-verified since. Evidence is limited to HTTP status and response shape; no request inputs or response bodies were uploaded.`,
      '',
      `Claims: ${claims.length} from run #${k.run_id ?? '-'}. Numbers in brackets are the uploaded evidence trial ids.`,
    );
  } else {
    lines.push(`Verified claims: ${claims.length} from run #${k.run_id ?? '-'}. Every claim below reproduced when re-run; numbers in brackets are the trial ids that back it.`);
  }

  const spec = claims.filter((c) => c.divergence_type === 'spec');
  lines.push('', `## Where behavior contradicts the spec (${spec.length})`);
  if (spec.length === 0) lines.push('', 'None found.');
  for (const d of collapseDivergences(spec)) lines.push('', d.line);

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
  const body = claims.filter((c) => c.divergence_type !== 'spec' && c.kind !== 'undocumented_constraint');

  // Facts that hold on EVERY endpoint go once, at the top, not once per endpoint.
  const common = commonAcrossEndpoints(body, endpoints);
  if (common.length) {
    lines.push('', endpoints.length === 2 ? '## Behavior common to both endpoints' : `## Behavior common to all ${endpoints.length} endpoints`);
    for (const g of common) lines.push(`- ${g.statement}${g.except ? ` (every endpoint except ${g.except})` : ''} ${ev(g.claims)}`);
  }
  const commonKeys = new Set(common.flatMap((g) => g.claims.map((c) => c.claim_key)));

  lines.push('', '## Endpoint behavior');
  for (const ep of endpoints) {
    const mine = body.filter((c) => c.endpoint === ep && !commonKeys.has(c.claim_key));
    lines.push('', `### ${ep}`);
    // Responses: only facts a caller acts on. Negative shape findings ("no nulls", "no pagination
    // fields") and plain JSON content types are padding and are left out.
    const shape = mine.filter((c) => c.kind === 'response_shape' && isActionableShape(c));
    if (shape.length) {
      lines.push('', 'Responses:');
      for (const c of shape.sort(byKey)) lines.push(`- ${c.statement} ${ev(c)}`);
    }
    const general = mine.filter((c) => !c.param && c.kind !== 'response_shape');
    if (general.length) {
      lines.push('', 'General:');
      for (const c of general.sort(byKind)) lines.push(`- ${c.statement} ${ev(c)}`);
    }
    const paramLines = renderParameterLines(summarizeParameters(mine.filter((c) => c.param)));
    if (paramLines.length) {
      lines.push('', 'Request validation:');
      lines.push(...paramLines);
    }
    if (!shape.length && !general.length && !paramLines.length) lines.push('', 'Nothing beyond the common behavior above.');
  }
  return lines.join('\n');
}

/** Shape claims worth a line: positives (nulls present, pagination fields, Link/rate-limit/cache headers, timestamps), not absences or "it is JSON". */
function isActionableShape(c: ClaimView): boolean {
  const s = c.statement;
  if (/content-type "application\/json/.test(s)) return false;
  if (/contains no null-valued fields/.test(s)) return false;
  if (/has no top-level pagination fields/.test(s)) return false;
  return true;
}

/** Rule families whose spec divergences read as one pattern when they recur across parameters and endpoints. */
const DIVERGENCE_FAMILY: Record<string, { key: string; line: (params: string, status: string) => string }> = {
  wrong_type: { key: 'type', line: (p, s) => `Declared types are not enforced: ${p} accept a wrong-type value ("abc") with ${s}.` },
  enum_invalid: { key: 'enum', line: (p, s) => `Documented enums are not enforced: ${p} accept values outside their enum with ${s}.` },
  boundary_above_max: { key: 'max', line: (p, s) => `Documented maximums are not enforced: ${p} accept values above the maximum with ${s}.` },
  boundary_far_above_max: { key: 'max', line: (p, s) => `Documented maximums are not enforced: ${p} accept values above the maximum with ${s}.` },
  boundary_below_min: { key: 'min', line: (p, s) => `Documented minimums are not enforced: ${p} accept values below the minimum with ${s}.` },
  required_omitted: { key: 'required', line: (p, s) => `Documented required parameters are not required: ${p} can be omitted with ${s}.` },
};

/**
 * The spec-divergence section, with one line per PATTERN rather than one per claim: GitHub's
 * twelve divergences are "enum and integer types are not validated on sort, order, page and
 * per_page", which should take one line, not a third of the money view. Only rule claims from
 * the families above collapse, and only when two or more share a family; everything else
 * (LLM divergences, lone claims) keeps its own line.
 */
export function collapseDivergences(spec: ClaimView[]): { line: string; claims: ClaimView[] }[] {
  const groups = new Map<string, ClaimView[]>();
  const single: ClaimView[] = [];
  for (const c of spec) {
    const rule = c.source === 'rules' ? ruleOf(c) : null;
    const fam = rule ? DIVERGENCE_FAMILY[rule] : undefined;
    if (fam) groups.set(fam.key, [...(groups.get(fam.key) ?? []), c]);
    else single.push(c);
  }
  const out: { line: string; claims: ClaimView[] }[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) {
      single.push(...list);
      continue;
    }
    const fam = Object.values(DIVERGENCE_FAMILY).find((f) => f.key === key)!;
    const params = [...new Set(list.map((c) => c.param).filter((p): p is string => !!p))].sort().map((p) => `"${p}"`);
    const eps = [...new Set(list.map((c) => c.endpoint))].sort();
    const statuses = [...new Set(list.map((c) => probeStatus(c)).filter((s): s is number => s !== null))].sort();
    const status = statuses.length ? statuses.map((s) => `HTTP ${s}`).join('/') : 'a success status';
    const specs = [...new Set(list.map((c) => c.spec_says).filter((s): s is string => !!s))];
    const where = eps.length === 1 ? eps[0] : `${eps.length} endpoints: ${eps.join(', ')}`;
    out.push({ line: `- **One pattern, ${list.length} claims** ${fam.line(params.join(', '), status)} On ${where}. Spec says: ${specs.slice(0, 3).join('; ')}${specs.length > 3 ? '; ...' : ''}. ${ev(list)}`, claims: list });
  }
  for (const c of single.sort(byKey)) out.push({ line: `- **${c.endpoint}** ${c.statement} Spec says: ${c.spec_says ?? 'n/a'}. ${ev(c)}`, claims: [c] });
  return out;
}

/**
 * Group endpoint-level claims by their rule and parameter; when the same rule produced the same
 * verdict and status on EVERY endpoint, present it once. The statement is taken from the first
 * endpoint with endpoint-specific wording removed where it is just the path.
 */
export function commonAcrossEndpoints(body: ClaimView[], endpoints: string[]): { statement: string; claims: ClaimView[]; except?: string }[] {
  if (endpoints.length < 2) return [];
  const groups = new Map<string, ClaimView[]>();
  for (const c of body) {
    if (c.source !== 'rules') continue;
    const rule = ruleOf(c);
    if (!rule) continue;
    const status = probeStatus(c);
    groups.set(`${rule}|${c.param ?? '-'}|${c.verdict}|${status}`, [...(groups.get(`${rule}|${c.param ?? '-'}|${c.verdict}|${status}`) ?? []), c]);
  }
  const out: { statement: string; claims: ClaimView[]; except?: string }[] = [];
  for (const [, list] of groups) {
    const eps = new Set(list.map((c) => c.endpoint));
    // Every endpoint, or (with 3+ endpoints) every endpoint but one: the same line repeated six
    // times under seven endpoints is padding; name the exception instead.
    const allButOne = endpoints.length >= 3 && eps.size === endpoints.length - 1;
    if (eps.size !== endpoints.length && !allButOne) continue;
    if (list[0].kind === 'response_shape' && !isActionableShape(list[0])) continue;
    const except = allButOne ? endpoints.find((e) => !eps.has(e)) : undefined;
    out.push({ statement: list[0].statement.replace(/\s*\(without it: HTTP \d+\)/, ''), claims: list, ...(except ? { except } : {}) });
  }
  return out.sort((a, b) => byKind(a.claims[0], b.claims[0]));
}

const KIND_ORDER = ['required', 'auth', 'type', 'pagination', 'error_behavior', 'undocumented', 'other'];
function byKind(a: ClaimView, b: ClaimView): number {
  return KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.claim_key.localeCompare(b.claim_key);
}
function byKey(a: ClaimView, b: ClaimView): number {
  return a.claim_key.localeCompare(b.claim_key);
}
