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
import { listTools, matchEndpoint, toolKnowledge, type ClaimView } from './queries.js';
import { memo } from './cache.js';

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

/** Rules whose claims are padding at the moment of use: present in the full sheet, never in the brief one. */
const BRIEF_SKIP_RULES = new Set(['method_head', 'wrong_content_type', 'path_trailing_slash', 'extra_field', 'baseline', 'shape_content_type', 'shape_cache_headers', 'shape_nulls', 'shape_pagination_fields', 'shape_timestamps']);
/**
 * In the brief sheet a pagination probe earns a line only when it REJECTS (the message carries the
 * real limit: "Only the first 1000 search results are available") or when a dedicated rule derived
 * something from it (clamp, empty last page, Link header). "page = 0 is accepted (HTTP 200)" six
 * times per endpoint is padding. Error-shape lines that say the errors do NOT share one shape are
 * padding too: there is nothing to act on.
 */
function briefWorthy(c: ClaimView): boolean {
  const rule = ruleOf(c);
  if (!rule) return true; // LLM claims of these kinds are usually the specific ones
  if (BRIEF_SKIP_RULES.has(rule)) return false;
  if (/^pagination_/.test(rule) && c.verdict !== 'rejects') return false;
  if (rule === 'error_shape' && /do not share one shape/.test(c.statement)) return false;
  return true;
}

/**
 * Pagination rejections with the same message on the same parameter become one line listing the
 * values: page=100000 and page=999999999 both rejected with "Only the first 10000 results are
 * available" is one fact, not two.
 */
function mergePaginationRejects(claims: ClaimView[]): string[] {
  const out: string[] = [];
  const merged = new Map<string, { values: string[]; rest: string; claims: ClaimView[] }>();
  for (const c of claims) {
    const m = /^pagination_/.test(ruleOf(c) ?? '') ? c.statement.match(/^Pagination parameter "([^"]+)" = (\S+) is rejected with (.*)$/) : null;
    if (!m) {
      out.push(`${c.statement} ${ev(c, 3)}`);
      continue;
    }
    const key = `${m[1]}|${m[3]}`;
    const g = merged.get(key) ?? { values: [], rest: m[3], claims: [] };
    g.values.push(m[2]);
    g.claims.push(c);
    merged.set(key, g);
  }
  for (const [key, g] of merged) {
    const param = key.split('|')[0];
    out.push(`Pagination parameter "${param}" = ${g.values.sort((a, b) => Number(a) - Number(b)).join(' or ')} is rejected with ${g.rest} ${ev(g.claims, 3)}`);
  }
  return out;
}

/** Claim kinds an agent acts on before its first call: how auth really behaves, how lists really paginate, what errors really look like. */
const BRIEF_KINDS = new Set(['auth', 'pagination', 'error_behavior']);

/**
 * @param opts.brief  the sheet the plugin hook injects: spec divergences, sibling differences,
 *   undocumented rules, and auth / pagination / error-behavior claims only, with 3 evidence ids
 *   each and a pointer to the full sheet. Reviewer finding: of ~9KB injected, six lines were
 *   actionable; an agent pays for every token of the rest.
 */
/**
 * Match a concrete request path ("/repos/github/rest-api-description/issues") to the covered
 * endpoint labels ("GET /repos/{owner}/{repo}/issues"): same segment count, template segments
 * match anything, the match with the fewest template segments wins. Null when nothing matches.
 */
export { matchEndpoint };

/**
 * What the compendium can and cannot tell the reader, appended to every sheet: which endpoints
 * of this API are probed (anything else on the host is not), which other APIs exist (by host),
 * what is not probed anywhere yet, and the tools to fetch more. Without this a reader of one
 * sheet cannot know what else is safe to ask for. The catalogue part is cached.
 */
async function coverageFooter(db: Db, tool: string, allEndpoints: string[]): Promise<string[]> {
  const others = await memo('catalogue', async () => {
    const all = await listTools(db);
    return all.filter((t) => t.verified_claims > 0).map((t) => ({ name: t.name, hosts: t.hosts as string[] }));
  }).catch(() => [] as { name: string; hosts: string[] }[]);
  const rest = others.filter((t) => t.name !== tool);
  const myHosts = others.find((t) => t.name === tool)?.hosts ?? [];
  const variants = rest.filter((t) => t.hosts.some((h) => myHosts.includes(h))).map((t) => t.name);
  const hosts = [...new Set(rest.filter((t) => !variants.includes(t.name)).flatMap((t) => t.hosts))].sort();
  return [
    '',
    '## What this compendium covers',
    `- This API: ${allEndpoints.length} GET endpoint(s) probed (listed in this sheet). Any other path on this host is NOT covered; do not infer its behavior from these.`,
    ...(variants.length ? [`- Same host, other variant(s): ${variants.join(', ')} (a different API version or configuration of the same service; this sheet is ${tool}, the default). Read one by passing its name as tool.`] : []),
    rest.length ? `- Other APIs: ${rest.length} (${hosts.join(', ')}). list_tools gives each with its hosts.` : '- Other APIs: none yet.',
    '- Not probed anywhere yet: write endpoints (POST/PUT/DELETE), request bodies, auth flows, hosts not listed above.',
    '- Fetch: get_tool_docs {tool, path?, brief?} for an endpoint; search_claims {query} for one question; get_tool_knowledge {tool, kind} for structured claims; get_divergences {tool}; request_target to ask for an uncovered public API (needs a key).',
  ];
}

/** One line per endpoint: the directory an agent descends with get_tool_docs {path}. */
function endpointIndex(tool: string, claims: ClaimView[], endpoints: string[], except: string | null, brief: boolean): string[] {
  const rows = endpoints
    .filter((e) => e !== except)
    .map((e) => {
      const mine = claims.filter((c) => c.endpoint === e);
      const div = mine.filter((c) => c.divergence_type === 'spec').length;
      const und = mine.filter((c) => c.kind === 'undocumented_constraint').length;
      return `- ${e}: ${mine.length} claims${div ? `, ${div} contradict the spec` : ''}${und ? `, ${und} undocumented rule(s)` : ''}`;
    });
  if (!rows.length) return [];
  const sample = (endpoints.find((e) => e !== except) ?? endpoints[0]).replace(/^[A-Z]+ /, '');
  return ['', `## Other endpoints covered (${rows.length})`, ...rows, `Fetch one: get_tool_docs {"tool":"${tool}","path":"${sample}"${brief ? '' : ',"full":true'}}`];
}

/**
 * @param opts.path  scope the sheet to the endpoint this request path matches (template segments
 *   match anything); the other endpoints are listed as an index, one line each, so the reader can
 *   descend to them by name instead of receiving them all. A path that matches nothing yields the
 *   unscoped sheet plus the index and a note.
 */
export async function renderToolDocs(db: Db, toolName: string, versionId?: number | null, opts: { brief?: boolean; path?: string | null } = {}): Promise<string | null> {
  const k = await toolKnowledge(db, toolName, versionId ?? null, false);
  if (!k) return null;
  const lines: string[] = [];
  const allClaims = k.claims;
  const allEndpoints = [...new Set(allClaims.map((c) => c.endpoint))].sort();
  const scoped = opts.path ? matchEndpoint(opts.path, allEndpoints) : null;
  // Endpoint-scoped: this endpoint's claims, plus the tool-wide lines (common block, auth) which
  // hold on every endpoint and are computed from everything.
  const claims = scoped ? allClaims.filter((c) => c.endpoint === scoped) : allClaims;

  lines.push(scoped ? `# ${k.tool}: verified behavior for ${scoped}` : `# ${k.tool}: verified behavior`);
  if (opts.path && !scoped && k.version) {
    if (opts.brief) {
      // A call to an uncovered path on a covered host: the brief answer is "not covered" plus the
      // directory, not the whole tool. (A whole-tool brief for api.github.com/.../actions/runs
      // cost 4KB of endpoints the caller was not using.)
      lines.push('', `No covered endpoint matches the path ${opts.path}. Nothing below describes that path; the compendium has not probed it. These are the endpoints it has:`);
      lines.push(...endpointIndex(k.tool, allClaims, allEndpoints, null, true));
      lines.push(...(await coverageFooter(db, k.tool, allEndpoints)));
      lines.push('', `Whole-tool sheet (tool-wide auth and pagination behavior may still apply): get_tool_docs {"tool":"${k.tool}"}.`);
      return lines.join('\n');
    }
    lines.push('', `No covered endpoint matches the path ${opts.path}; this is the whole tool. The covered endpoints are listed at the end.`);
  }
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
    for (const c of constraints) lines.push('', `- **${c.endpoint}** ${c.statement} ${opts.brief ? ev(c, 3) : ev(c)}`);
  }

  if (opts.brief) {
    const eps = scoped ? [scoped] : allEndpoints;
    const watchAll = allClaims.filter((c) => (BRIEF_KINDS.has(c.kind) || c.source === 'scenario') && c.divergence_type !== 'spec' && briefWorthy(c));
    const common = commonAcrossEndpoints(watchAll, allEndpoints).filter((g) => !scoped || g.except !== scoped);
    const commonKeys = new Set(common.flatMap((g) => g.claims.map((c) => c.claim_key)));
    const watch = watchAll.filter((c) => eps.includes(c.endpoint));
    lines.push('', scoped ? `## Watch out for (auth, pagination, errors) on ${scoped}` : '## Watch out for (auth, pagination, errors)');
    for (const g of common) lines.push(`- ${g.statement}${g.except ? ` (every endpoint except ${g.except})` : ''} ${ev(g.claims, 3)}`);
    for (const ep of eps) {
      const mine = watch.filter((c) => c.endpoint === ep && !commonKeys.has(c.claim_key)).sort(byKind);
      for (const line of mergePaginationRejects(mine)) lines.push(scoped ? `- ${line}` : `- **${ep}** ${line}`);
    }
    if (!common.length && !watch.length) lines.push('- Nothing beyond the sections above.');
    lines.push(...endpointIndex(k.tool, allClaims, allEndpoints, scoped, true));
    lines.push(...(await coverageFooter(db, k.tool, allEndpoints)));
    lines.push('', `Full sheet${scoped ? ' for this endpoint' : ''} (response shapes, per-parameter validation, common behavior, all evidence ids): get_tool_docs {"tool":"${k.tool}"${scoped ? `,"path":"${scoped.replace(/^[A-Z]+ /, '')}"` : ''},"full":true}. One question: search_claims.`);
    return lines.join('\n');
  }

  const endpoints = scoped ? [scoped] : allEndpoints;
  // Scenario claims (the API used the way a program uses it, judged by invariants): their own section.
  const usage = claims.filter((c) => c.source === 'scenario');
  if (usage.length) {
    lines.push('', `## How it behaves in use (${usage.length})`, '', 'Multi-request scenarios checked against invariants the docs never state: paging (each item once, Link chain vs page numbers, stability between reads), conditional requests (ETag / If-None-Match, whether a 304 costs quota), and rate-limit accounting. Each line cites every request in its sequence.');
    for (const c of usage.sort(byKey)) lines.push(`- **${c.endpoint}** ${c.statement} ${ev(c)}`);
  }
  const body = claims.filter((c) => c.divergence_type !== 'spec' && c.kind !== 'undocumented_constraint' && c.source !== 'scenario');

  // Facts that hold on EVERY endpoint go once, at the top, not once per endpoint. When scoped,
  // they are computed over the whole tool (they hold here too) unless this endpoint is the exception.
  const common = commonAcrossEndpoints(scoped ? allClaims.filter((c) => c.divergence_type !== 'spec' && c.kind !== 'undocumented_constraint') : body, allEndpoints).filter((g) => !scoped || g.except !== scoped);
  if (common.length) {
    lines.push('', allEndpoints.length === 2 ? '## Behavior common to both endpoints' : `## Behavior common to all ${allEndpoints.length} endpoints`);
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
  lines.push(...endpointIndex(k.tool, allClaims, allEndpoints, scoped, false));
  lines.push(...(await coverageFooter(db, k.tool, allEndpoints)));
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
