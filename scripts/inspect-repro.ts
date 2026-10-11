import { getDb, closeDb } from '../src/db/client.js';
import { trialById, toolKnowledge } from '../src/db/queries.js';
import { runOne } from '../src/worker/exercise.js';
import { describeSignature, signaturesEqual } from '../src/worker/signature.js';
import { canonicalJson } from '../src/worker/spec.js';
import type { TrialInput } from '../src/worker/http.js';
const db = await getDb();
for (const id of (process.argv[2] ?? '1218,1219,1265').split(',').map(Number)) {
  const t = await trialById(db, id);
  if (!t) continue;
  const stored = t.signature as any;
  const { out } = await runOne(t.input as unknown as TrialInput, {});
  console.log(`\n#${id} ${t.endpoint} ${t.mutationId}`);
  console.log('  stored:', describeSignature(stored), '| fresh:', describeSignature(out.signature), '| equal:', signaturesEqual(stored, out.signature));
  if (!signaturesEqual(stored, out.signature)) {
    const a = canonicalJson(stored.shape), b = canonicalJson(out.signature.shape);
    console.log('  stored shape:', a.slice(0, 300)); console.log('  fresh  shape:', b.slice(0, 300));
    console.log('  stored err:', stored.errorMessage, '| fresh err:', out.signature.errorMessage);
  }
  await new Promise((r) => setTimeout(r, 400));
}
const k = await toolKnowledge(db, 'nws-weather-gov');
console.log('\n=== stored auth claims (run', k?.run_id, ')');
for (const c of k?.claims.filter((c) => c.kind === 'auth') ?? []) console.log(' ', c.endpoint, '::', c.statement);
await closeDb();
