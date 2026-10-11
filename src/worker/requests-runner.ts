/**
 * Process pending user-requested targets: run each through the pipeline
 * (rules-only unless an adapter is given), record the run id on success or
 * the error on failure. Shared by the CLI (`requests process`, `run-all`)
 * and the integration tests.
 */
import type { Db } from '../db/client.js';
import { listRequests, markRequest } from '../db/requests.js';
import { log } from './log.js';
import { runPipeline, type PipelineOptions } from './pipeline.js';
import type { TargetConfig } from './target.js';

export interface ProcessedRequest {
  id: number;
  name: string;
  status: 'done' | 'failed';
  testRunId: number | null;
  note: string;
}

export async function processPendingRequests(db: Db, opts: PipelineOptions = {}): Promise<ProcessedRequest[]> {
  const pending = await listRequests(db, ['pending']);
  const out: ProcessedRequest[] = [];
  for (const r of pending.reverse()) {
    await markRequest(db, r.id, { status: 'running', startedAt: new Date() });
    log.info('requests', `processing request #${r.id} ${r.name} (${r.specUrl})`);
    try {
      const s = await runPipeline(db, r.target as unknown as TargetConfig, opts);
      const note = `run #${s.testRunId}: ${s.trials} trials, ${s.verified.length} verified, ${s.divergences} divergences`;
      await markRequest(db, r.id, { status: 'done', note, testRunId: s.testRunId, finishedAt: new Date() });
      out.push({ id: r.id, name: r.name, status: 'done', testRunId: s.testRunId, note });
    } catch (e) {
      const note = `failed: ${(e as Error).message}`;
      await markRequest(db, r.id, { status: 'failed', note, finishedAt: new Date() });
      log.error('requests', `request #${r.id} ${r.name} ${note}`);
      out.push({ id: r.id, name: r.name, status: 'failed', testRunId: null, note });
    }
  }
  return out;
}
