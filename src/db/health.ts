/**
 * HEALTH: the maintainer's view of whether the nightly refresh is doing its job, per tool.
 *
 * The freshness label tells an AGENT that a sheet is old or thin at the moment it reads it. This
 * tells the MAINTAINER, in run-all's output and through the workflow's exit code, before any agent
 * has to find out. Two kinds of signal:
 *
 *   red  (fails the nightly workflow, so an email goes out)
 *     stale             a scheduled tool whose last claim-producing run is older than STALE_DAYS
 *     coverage_dropped  the latest finished run kept < half the claims of the BEST of the previous
 *                       producing runs (so a second thin night does not clear the alert), or none
 *     failing           the last 3+ runs all failed; never_produced after 3 runs of a scheduled tool
 *   warn (printed, never fails the workflow)
 *     failed_once       the latest run failed but earlier ones did not (one bad night is routine)
 *     never_produced    no run has ever stored a claim (an unreachable API, a broken target)
 *     unscheduled       no target file: the tool was run by hand once and is never refreshed
 *
 * "ok" means none of the above. Pure classification lives in classifyHealth so it can be tested
 * without a database; toolHealth gathers the inputs.
 */
import { desc, eq, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';
import { ageDays, coverageDropped, STALE_DAYS } from './freshness.js';

export type HealthLevel = 'ok' | 'warn' | 'red';
export type HealthCode = 'stale' | 'coverage_dropped' | 'failing' | 'failed_once' | 'never_produced' | 'unscheduled';

export interface HealthInput {
  tool: string;
  /** Known to be refreshed by the nightly job (has a target file); null when the caller cannot tell. */
  scheduled: boolean | null;
  /** Newest runs first: status and the claims each stored (0 for failed / empty). */
  runs: { id: number; status: string; at: Date; claims: number; error?: string | null }[];
}

export interface HealthIssue {
  level: HealthLevel;
  code: HealthCode;
  detail: string;
}

export interface ToolHealth extends HealthInput {
  level: HealthLevel;
  issues: HealthIssue[];
  lastClaimRun: { id: number; at: Date; claims: number } | null;
}

const worst = (a: HealthLevel, b: HealthLevel): HealthLevel => (a === 'red' || b === 'red' ? 'red' : a === 'warn' || b === 'warn' ? 'warn' : 'ok');

export function classifyHealth(input: HealthInput, now: Date = new Date()): ToolHealth {
  const issues: HealthIssue[] = [];
  const finished = input.runs.filter((r) => r.status === 'finished');
  const producing = finished.filter((r) => r.claims > 0);
  const last = input.runs[0] ?? null;
  const latestFinished = finished[0] ?? null;
  const lastClaimRun = producing[0] ?? null;
  // The reference for a drop is the best of the previous producing runs (up to 7), not just the one
  // before: comparing a thin night with the thin night before it would clear the alert unfixed.
  const earlier = producing.filter((r) => r !== lastClaimRun).slice(0, 7);
  const best = earlier.length ? earlier.reduce((a, b) => (b.claims > a.claims ? b : a)) : null;
  // For a run that stored nothing, the reference includes the last producing run itself.
  const bestAll = producing.length ? producing.slice(0, 7).reduce((a, b) => (b.claims > a.claims ? b : a)) : null;
  const day = (r: { at: Date }) => r.at.toISOString().slice(0, 10);

  if (input.scheduled === false) issues.push({ level: 'warn', code: 'unscheduled', detail: 'no target file: never refreshed by the nightly run' });
  if (!lastClaimRun) {
    // Same contract as "failing": a scheduled tool that has had three chances and stored nothing is red.
    const level: HealthLevel = input.scheduled === true && input.runs.length >= 3 ? 'red' : 'warn';
    issues.push({ level, code: 'never_produced', detail: input.runs.length ? `${input.runs.length} run(s), none stored a claim, last ${day(last!)}${last?.error ? ` (${last.error.slice(0, 80)})` : ''}` : 'no runs yet' });
  } else {
    const age = ageDays(lastClaimRun.at, now);
    if (age > STALE_DAYS) issues.push({ level: input.scheduled === false ? 'warn' : 'red', code: 'stale', detail: `last claims ${age} days ago (run #${lastClaimRun.id} on ${day(lastClaimRun)})` });
    if (latestFinished && latestFinished.claims === 0 && bestAll && bestAll.claims >= 10) issues.push({ level: 'red', code: 'coverage_dropped', detail: `run #${latestFinished.id} on ${day(latestFinished)} stored no claims; the best of the previous runs, #${bestAll.id} on ${day(bestAll)}, had ${bestAll.claims}` });
    else if (best && coverageDropped(lastClaimRun.claims, best.claims)) issues.push({ level: 'red', code: 'coverage_dropped', detail: `run #${lastClaimRun.id} on ${day(lastClaimRun)} kept ${lastClaimRun.claims} claims; the best of the previous runs, #${best.id} on ${day(best)}, had ${best.claims}` });
  }
  let streak = 0;
  for (const r of input.runs) {
    if (r.status === 'failed') streak++;
    else break;
  }
  if (streak >= 3) issues.push({ level: 'red', code: 'failing', detail: `last ${streak} runs failed, latest ${day(last!)}${last?.error ? ` (${last.error.slice(0, 80)})` : ''}` });
  else if (streak >= 1 && lastClaimRun) issues.push({ level: 'warn', code: 'failed_once', detail: `latest run #${last!.id} on ${day(last!)} failed${last?.error ? ` (${last.error.slice(0, 80)})` : ''}; claims from run #${lastClaimRun.id} on ${day(lastClaimRun)} stand` });

  const level = issues.reduce<HealthLevel>((acc, i) => worst(acc, i.level), 'ok');
  return { ...input, level, issues, lastClaimRun };
}

/** Health of every tool. `scheduled` is the set of tool names with a target file; omit when unknown. */
export async function toolHealth(db: Db, opts: { now?: Date; scheduled?: Set<string>; maxRuns?: number } = {}): Promise<ToolHealth[]> {
  const tools = await db.select().from(schema.tools).orderBy(schema.tools.name);
  const out: ToolHealth[] = [];
  for (const t of tools) {
    const rows = await db
      .select({ id: schema.testRuns.id, status: schema.testRuns.status, startedAt: schema.testRuns.startedAt, finishedAt: schema.testRuns.finishedAt, stats: schema.testRuns.stats })
      .from(schema.testRuns)
      .innerJoin(schema.toolVersions, eq(schema.testRuns.toolVersionId, schema.toolVersions.id))
      .where(eq(schema.toolVersions.toolId, t.id))
      .orderBy(desc(schema.testRuns.id))
      .limit(opts.maxRuns ?? 10);
    const runs: HealthInput['runs'] = [];
    for (const r of rows) {
      const [{ n }] = r.status === 'finished' ? await db.select({ n: sql<number>`count(*)::int` }).from(schema.claims).where(eq(schema.claims.testRunId, r.id)) : [{ n: 0 }];
      const error = (r.stats as { error?: string } | null)?.error ?? null;
      // A run still 'running' a day after it started was killed (job timeout, worker crash): a failed night.
      const abandoned = r.status === 'running' && ageDays(r.startedAt, opts.now ?? new Date()) >= 1;
      runs.push({ id: r.id, status: abandoned ? 'failed' : r.status, at: r.finishedAt ?? r.startedAt, claims: Number(n), error: abandoned ? 'run never finished (killed or timed out)' : error });
    }
    out.push(classifyHealth({ tool: t.name, scheduled: opts.scheduled ? opts.scheduled.has(t.name) : null, runs }, opts.now));
  }
  return out;
}

/** One line per tool with an issue, worst first; the all-clear line when there is none. */
export function formatHealth(rows: ToolHealth[]): string[] {
  const order: Record<HealthLevel, number> = { red: 0, warn: 1, ok: 2 };
  const bad = rows.filter((r) => r.level !== 'ok').sort((a, b) => order[a.level] - order[b.level] || a.tool.localeCompare(b.tool));
  if (!bad.length) return [`HEALTH: all ${rows.length} tool(s) ok`];
  const reds = bad.filter((r) => r.level === 'red').length;
  return [`HEALTH: ${reds} red, ${bad.length - reds} warn, ${rows.length - bad.length} ok`, ...bad.map((r) => `  ${r.level.toUpperCase().padEnd(4)} ${r.tool.padEnd(26)} ${r.issues.map((i) => `${i.code}: ${i.detail}`).join('; ')}`), `  Re-run one: npm run autopia -- run targets/<name>.json; history: npm run autopia -- runs <name>`];
}
