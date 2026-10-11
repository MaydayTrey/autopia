import { loadTarget, selectEndpoints } from '../src/worker/target.js';
import { fetchSpecText, parseSpecText, extractEndpoints, hashSpec } from '../src/worker/spec.js';
import { planAll } from '../src/worker/exercise.js';
import { buildUrl } from '../src/worker/http.js';
const target = await loadTarget(process.argv[2] ?? 'targets/open-meteo-forecast.json');
const doc = parseSpecText(await fetchSpecText(target.spec_url));
const all = extractEndpoints(doc, { server: target.server, overrideServer: target.override_server });
const parsed = { ...all, endpoints: selectEndpoints(all.endpoints, target) };
console.log('title:', parsed.title, 'version:', parsed.version, 'hash:', hashSpec(doc).slice(0, 12));
for (const ep of parsed.endpoints) {
  console.log(ep.method, ep.path, 'server', ep.server, 'security', ep.hasSecurity);
  for (const p of ep.params) console.log('  ', p.name, p.in, p.required ? 'REQ' : 'opt', p.type, p.itemType ?? '', p.enum ? `enum(${p.enum.length})` : '', p.minimum ?? '', p.maximum ?? '', p.format ?? '');
}
const plan = planAll(parsed.endpoints, target, 10000);
console.log('\nplanned trials:', plan.length);
const byType: Record<string, number> = {};
for (const t of plan) byType[t.type] = (byType[t.type] ?? 0) + 1;
console.log(byType);
for (const t of plan.slice(0, 6)) console.log(t.id, '->', buildUrl(t.input).slice(0, 140));
