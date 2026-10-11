#!/usr/bin/env node
/**
 * Autopia worker CLI.
 *
 *   npm run autopia -- run <target.json> [--no-llm] [--max-trials N] [--no-reproduce]
 *   npm run autopia -- plan <target.json>          print the trial plan, no HTTP
 *   npm run autopia -- tools                        catalogue
 *   npm run autopia -- versions <tool>
 *   npm run autopia -- runs <tool>
 *   npm run autopia -- claims <tool> [--divergences] [--version ID] [--json]
 *   npm run autopia -- search "<question>" [--tool NAME]
 *   npm run autopia -- diff <tool> <fromVersionId> <toVersionId>
 *   npm run autopia -- trial <id>                   show one trial in full
 *   npm run autopia -- compare-runs <tool>          determinism check: last two runs
 *
 * Set AUTOPIA_LOG=debug for per-trial output.
 */
import { parseArgs } from 'node:util';
import { closeDb, getDb } from '../db/client.js';
import { listTools, listVersions, resolveTool, runsForTool, searchClaims, toolKnowledge, trialById, versionDiff } from '../db/queries.js';
import { adapterFromEnv } from '../llm/anthropic.js';
import { buildUrl } from './http.js';
import { planAll } from './exercise.js';
import { log } from './log.js';
import { runPipeline } from './pipeline.js';
import { extractEndpoints, fetchSpecText, parseSpecText } from './spec.js';
import { loadTarget, selectEndpoints } from './target.js';
import { latestClaimsForVersion } from './diff.js';
import { loadEnv } from './env.js';

loadEnv();

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    llm: { type: 'boolean', default: true },
    reproduce: { type: 'boolean', default: true },
    'max-trials': { type: 'string' },
    divergences: { type: 'boolean', default: false },
    version: { type: 'string' },
    tool: { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const [cmd, ...args] = positionals;

function out(v: unknown) {
  process.stdout.write(typeof v === 'string' ? v + '\n' : JSON.stringify(v, null, 2) + '\n');
}

async function main() {
  switch (cmd) {
    case 'run': {
      const target = await loadTarget(need(args[0], 'target file'));
      const llm = values.llm ? adapterFromEnv() : null;
      if (values.llm && !llm) log.warn('cli', 'ANTHROPIC_API_KEY not set: running rules-only (no LLM pass)');
      const db = await getDb();
      const s = await runPipeline(db, target, { llm, reproduce: values.reproduce, maxTrials: values['max-trials'] ? Number(values['max-trials']) : undefined });
      out('');
      out(`RUN #${s.testRunId}  ${s.toolName}  version #${s.toolVersionId}${s.isNewVersion ? ' (new)' : ''}  ${(s.durationMs / 1000).toFixed(1)}s`);
      out(`  trials ${s.trials} | candidates rules ${s.candidates.rules} + llm ${s.candidates.llm} (${s.candidates.llmDiscarded} discarded) | quarantined ${s.quarantined} | rejected ${s.rejected.length} | VERIFIED ${s.verified.length} | DIVERGENCES ${s.divergences}`);
      if (s.llm.model) out(`  llm ${s.llm.model}: ${s.llm.inputTokens} in / ${s.llm.outputTokens} out tokens`);
      if (s.diff) out(`  diff vs version #${s.diff.fromVersionId}: ${JSON.stringify(s.diff.counts)}`);
      for (const r of s.rejected) out(`  rejected: ${r.reason}  <- ${r.claim.statement}`);
      out('');
      for (const c of s.verified.filter((c) => c.divergenceType === 'spec')) out(`  !! SPEC DIVERGENCE [${c.kind}] ${c.endpoint} :: ${c.statement}  (spec: ${c.specSays ?? '-'})  evidence ${c.evidenceTrialIds.join(',')}`);
      for (const c of s.verified.filter((c) => c.siblingNote)) out(`  ~~ SIBLING DIFFERS [${c.kind}] ${c.endpoint} :: ${c.statement}  (${c.siblingNote})  evidence ${c.evidenceTrialIds.join(',')}`);
      break;
    }
    case 'plan': {
      const target = await loadTarget(need(args[0], 'target file'));
      const parsed = extractEndpoints(parseSpecText(await fetchSpecText(target.spec_url)), { server: target.server });
      const plan = planAll(selectEndpoints(parsed.endpoints, target), target, target.max_trials ?? 500);
      out(`${parsed.title} v${parsed.version}: ${parsed.endpoints.length} endpoint(s), ${plan.length} trials`);
      for (const t of plan) out(`${t.endpoint}  ${t.id.padEnd(36)} ${t.input.method} ${buildUrl(t.input).slice(0, 150)}`);
      break;
    }
    case 'tools': {
      const db = await getDb();
      const rows = await listTools(db);
      if (values.json) out(rows);
      else for (const r of rows) out(`#${r.id} ${r.name}  versions ${r.versions}  latest #${r.latest_version_id ?? '-'} (${r.latest_version_label ?? '-'})  verified claims ${r.verified_claims}  divergences ${r.divergences}`);
      break;
    }
    case 'versions': {
      const db = await getDb();
      const tool = await resolveTool(db, need(args[0], 'tool name'));
      if (!tool) throw new Error('no such tool');
      for (const v of await listVersions(db, tool.id)) {
        const cur = await latestClaimsForVersion(db, v.id);
        out(`#${v.id} label ${v.versionLabel ?? '-'} hash ${v.specHash.slice(0, 12)} discovered ${v.discoveredAt.toISOString()} claims ${cur?.claims.length ?? 0} (run #${cur?.runId ?? '-'})`);
      }
      break;
    }
    case 'runs': {
      const db = await getDb();
      const tool = await resolveTool(db, need(args[0], 'tool name'));
      if (!tool) throw new Error('no such tool');
      for (const r of await runsForTool(db, tool.id)) out(`run #${r.id} version #${r.versionId} ${r.status} ${r.startedAt.toISOString()} llm ${r.llmModel ?? '-'} ${r.llmInputTokens}/${r.llmOutputTokens} stats ${JSON.stringify(r.stats)}`);
      break;
    }
    case 'claims': {
      const db = await getDb();
      const k = await toolKnowledge(db, need(args[0], 'tool name'), values.version ? Number(values.version) : null, values.divergences);
      if (!k) throw new Error('no such tool');
      if (values.json) out(k);
      else {
        out(`${k.tool} version #${k.version?.id ?? '-'} run #${k.run_id ?? '-'}: ${k.claims.length} claims`);
        for (const [kind, list] of Object.entries(k.by_kind)) {
          out(`\n[${kind}]`);
          for (const c of list) out(`  ${c.diverges_from_spec ? '!! ' : c.sibling_note ? '~~ ' : '   '}${c.statement}  {${c.source}, conf ${c.confidence}, evidence ${c.evidence.map((e) => e.id).join(',')}}${c.spec_says ? `  spec: ${c.spec_says}` : ''}${c.sibling_note ? `  sibling: ${c.sibling_note}` : ''}`);
        }
      }
      break;
    }
    case 'search': {
      const db = await getDb();
      const rows = await searchClaims(db, need(args[0], 'query'), values.tool ?? null);
      if (values.json) out(rows);
      else for (const c of rows) out(`${c.diverges_from_spec ? '!! ' : '   '}[${c.kind}] ${c.statement}  (evidence ${c.evidence.map((e) => e.id).join(',')})`);
      break;
    }
    case 'diff': {
      const db = await getDb();
      const d = await versionDiff(db, need(args[0], 'tool name'), Number(need(args[1], 'from version id')), Number(need(args[2], 'to version id')));
      if (!d) throw new Error('no such tool');
      if (values.json) out(d);
      else {
        out(`${d.tool}: #${d.from_version_id} -> #${d.to_version_id}  ${JSON.stringify(d.counts)}`);
        for (const c of d.changes) out(`  ${c.change.toUpperCase().padEnd(8)} ${c.claim_key}\n           before: ${c.before?.statement ?? '-'}\n           after:  ${c.after?.statement ?? '-'}`);
      }
      break;
    }
    case 'trial': {
      const db = await getDb();
      const t = await trialById(db, Number(need(args[0], 'trial id')));
      out(t ?? 'no such trial');
      break;
    }
    case 'compare-runs': {
      const db = await getDb();
      const tool = await resolveTool(db, need(args[0], 'tool name'));
      if (!tool) throw new Error('no such tool');
      const runs = (await runsForTool(db, tool.id)).filter((r) => r.status === 'finished');
      if (runs.length < 2) throw new Error('need two finished runs');
      const { schema } = await import('../db/client.js');
      const { and, eq } = await import('drizzle-orm');
      // Rules claims must be identical run to run (determinism criterion). LLM claims are
      // reported separately: the model is not deterministic, and that layer is additive.
      const keys = async (runId: number, source: string) =>
        new Set((await db.select({ k: schema.claims.claimKey }).from(schema.claims).where(and(eq(schema.claims.testRunId, runId), eq(schema.claims.source, source)))).map((r) => r.k));
      for (const source of ['rules', 'llm']) {
        const [a, b] = [await keys(runs[1].id, source), await keys(runs[0].id, source)];
        const onlyA = [...a].filter((k) => !b.has(k));
        const onlyB = [...b].filter((k) => !a.has(k));
        const same = onlyA.length + onlyB.length === 0;
        out(`${source.padEnd(5)} run #${runs[1].id} (${a.size}) vs run #${runs[0].id} (${b.size}): ${same ? 'IDENTICAL' : 'DIFFERENT'}${source === 'rules' ? (same ? ' -> deterministic' : ' -> NOT deterministic, investigate') : ' (model layer; differences are expected)'}`);
        for (const k of onlyA) out(`  only in #${runs[1].id}: ${k}`);
        for (const k of onlyB) out(`  only in #${runs[0].id}: ${k}`);
      }
      break;
    }
    default:
      out('usage: autopia <run|plan|tools|versions|runs|claims|search|diff|trial|compare-runs> ...  (see src/worker/cli.ts)');
      process.exitCode = 1;
  }
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
}

main()
  .catch((e) => {
    log.error('cli', (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
