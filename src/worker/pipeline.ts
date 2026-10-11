/**
 * The worker pipeline, one target at a time:
 *   discover -> exercise -> aggregate -> cross-ref -> verify -> write (+ diff)
 *
 * Returns a RunSummary that the CLI prints and tests assert on. The test_run
 * row carries the same numbers in `stats` plus token spend for the LLM pass.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import { siblingClaims } from '../db/queries.js';
import type { Claim, Trial } from '../db/schema.js';
import type { LlmAdapter } from '../llm/adapter.js';
import { carryForwardLlmClaims, dropSupersededCarried } from './aggregate/carry.js';
import { llmClaims } from './aggregate/llm.js';
import { rulesClaims } from './aggregate/rules.js';
import { trialsByIds } from '../db/queries.js';
import { latestClaimsForVersion } from './diff.js';
import { batteryHash } from './battery/index.js';
import type { CandidateClaim } from './claims.js';
import { crossReference } from './crossref.js';
import { computeAndStoreDiff, countBy, type DiffEntry } from './diff.js';
import { discover } from './discover.js';
import { exercise, type ExerciseOptions } from './exercise.js';
import { log } from './log.js';
import { intervalFor, selectEndpoints, type TargetConfig } from './target.js';
import { secretsOf } from './redact.js';
import { evidenceCheck, verify } from './verify.js';
import { writeClaims } from './write.js';

export interface PipelineOptions extends ExerciseOptions {
  llm?: LlmAdapter | null; // null/undefined = rules only
  reproduce?: boolean;
}

export interface RunSummary {
  toolId: number;
  toolName: string;
  toolVersionId: number;
  isNewVersion: boolean;
  testRunId: number;
  trials: number;
  candidates: { rules: number; llm: number; llmDiscarded: number; carried: number; carriedDropped: number };
  quarantined: number;
  rejected: { claim: CandidateClaim; reason: string }[];
  verified: Claim[];
  divergences: number;
  diff: { fromVersionId: number; counts: ReturnType<typeof countBy>; entries: DiffEntry[] } | null;
  llm: { model: string | null; inputTokens: number; outputTokens: number };
  durationMs: number;
}

export async function runPipeline(db: Db, target: TargetConfig, opts: PipelineOptions = {}): Promise<RunSummary> {
  const started = Date.now();

  // 1-2. DISCOVER (then narrow to the target's include_paths, if any)
  const d = await discover(db, target);
  d.parsed = { ...d.parsed, endpoints: selectEndpoints(d.parsed.endpoints, target) };
  if (target.include_paths) log.info('discover', `include_paths: exercising ${d.parsed.endpoints.length} of the spec's endpoints`);
  const [run] = await db.insert(schema.testRuns).values({ toolVersionId: d.version.id, batteryHash: batteryHash(), status: 'running' }).returning();
  log.info('pipeline', `test_run #${run.id} for ${d.tool.name} version #${d.version.id}`);

  try {
    // 3. EXERCISE
    const trials: Trial[] = await exercise(db, run.id, d.parsed.endpoints, target, opts);
    const trialsById = new Map(trials.map((t) => [t.id, t]));

    // 4. AGGREGATE: rules first (free), then one LLM pass (optional)
    const ruleClaims = rulesClaims(trials, d.parsed.endpoints);
    log.info('aggregate', `rules produced ${ruleClaims.length} candidate claims`);
    let llmResult: Awaited<ReturnType<typeof llmClaims>> | null = null;
    if (opts.llm) {
      llmResult = await llmClaims(opts.llm, trials, d.parsed.endpoints, ruleClaims);
    } else {
      log.info('aggregate', 'LLM pass skipped (no adapter configured); rules-only run');
    }
    // Carry forward the previous run's LLM claims (no model cost); fresh LLM claims win on key ties.
    const prev = await latestClaimsForVersion(db, d.version.id);
    let carried: ReturnType<typeof carryForwardLlmClaims> = { claims: [], dropped: [] };
    if (prev) {
      const prevLlm = prev.claims.filter((c) => c.source === 'llm');
      const prevTrials = await trialsByIds(db, [...new Set(prevLlm.flatMap((c) => c.evidenceTrialIds))]);
      carried = carryForwardLlmClaims(prevLlm, prevTrials, trials);
      if (carried.claims.length) carried = dropSupersededCarried(carried, llmResult?.claims ?? [], trialsById);
    }
    const candidates = [...ruleClaims, ...(llmResult?.claims ?? []), ...carried.claims];

    // 5a. EVIDENCE CHECK first (free). A claim that mis-states what its own
    // trials showed is simply wrong; dropping it here keeps it from being
    // mistaken for a "contradiction" that would quarantine correct claims.
    const evidenceRejected: { claim: CandidateClaim; reason: string }[] = [];
    const withEvidence = candidates.filter((c) => {
      const err = evidenceCheck(c, trialsById);
      if (err) evidenceRejected.push({ claim: c, reason: `evidence: ${err}` });
      return !err;
    });
    if (evidenceRejected.length) log.warn('verify', `evidence check dropped ${evidenceRejected.length} candidate(s) before cross-ref`, evidenceRejected.map((r) => r.reason));

    // 5b. CROSS-REF (spec tagging + sibling tagging + self-consistency)
    const siblings = await siblingClaims(db, d.tool.id, d.tool.category);
    if (siblings.size) log.info('crossref', `comparing against ${siblings.size} sibling claim keys in category "${d.tool.category}"`);
    const xr = crossReference(withEvidence, d.parsed.endpoints, siblings);

    // 6. VERIFY (evidence check again, then reproduction)
    const v = await verify(xr.kept, trialsById, { ...opts, minIntervalMs: opts.minIntervalMs ?? target.rate?.min_interval_ms, reproduce: opts.reproduce, secrets: secretsOf(target), intervalFor: (ep) => intervalFor(target, ep) });
    v.rejected.unshift(...evidenceRejected);

    // 7. WRITE + DIFF
    const stored = await writeClaims(db, d.version.id, run.id, v.verified);
    const diff = stored.length ? await computeAndStoreDiff(db, d.tool.id, d.version.id, stored) : null;

    const summary: RunSummary = {
      toolId: d.tool.id,
      toolName: d.tool.name,
      toolVersionId: d.version.id,
      isNewVersion: d.isNewVersion,
      testRunId: run.id,
      trials: trials.length,
      candidates: { rules: ruleClaims.length, llm: llmResult?.claims.length ?? 0, llmDiscarded: llmResult?.discarded.length ?? 0, carried: carried.claims.length, carriedDropped: carried.dropped.length },
      quarantined: xr.quarantined.length,
      rejected: v.rejected,
      verified: stored,
      divergences: stored.filter((c) => c.divergenceType).length,
      diff: diff ? { fromVersionId: diff.fromVersionId, counts: countBy(diff.entries), entries: diff.entries } : null,
      llm: { model: llmResult?.model ?? null, inputTokens: llmResult?.usage.inputTokens ?? 0, outputTokens: llmResult?.usage.outputTokens ?? 0 },
      durationMs: Date.now() - started,
    };

    await db
      .update(schema.testRuns)
      .set({
        status: 'finished',
        finishedAt: new Date(),
        llmModel: summary.llm.model,
        llmInputTokens: Math.round(summary.llm.inputTokens),
        llmOutputTokens: Math.round(summary.llm.outputTokens),
        stats: {
          trials: summary.trials,
          candidates: summary.candidates,
          quarantined: summary.quarantined,
          rejected: summary.rejected.length,
          rejectedReasons: summary.rejected.map((r) => ({ key: r.claim.claim_key, reason: r.reason })),
          verified: summary.verified.length,
          divergences: summary.divergences,
          diff: summary.diff?.counts ?? null,
          durationMs: summary.durationMs,
        },
      })
      .where(eq(schema.testRuns.id, run.id));

    log.info('pipeline', `done in ${summary.durationMs}ms: ${summary.trials} trials -> ${candidates.length} candidates -> ${stored.length} verified (${summary.divergences} divergences)`);
    return summary;
  } catch (e) {
    await db.update(schema.testRuns).set({ status: 'failed', finishedAt: new Date(), stats: { error: String((e as Error).message ?? e) } }).where(eq(schema.testRuns.id, run.id));
    throw e;
  }
}
