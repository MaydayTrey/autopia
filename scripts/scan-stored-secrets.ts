/**
 * Read-only audit: do any stored trial inputs, responses, requests or contributions contain
 * credential-shaped strings? Trial inputs are served to MCP clients as evidence
 * (request.headers), so a real token stored before redaction would leak to anyone with a key.
 * Prints counts and masked samples only; never a full value.
 *
 *   npx tsx scripts/scan-stored-secrets.ts
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/db/client.js';
import { loadEnv } from '../src/worker/env.js';

loadEnv();

// Placeholders the battery and targets legitimately store.
const ALLOW = /invalid-key-autopia|\$\{[A-Z_]+\}|\[redacted\]|REDACTED/;
const PATTERNS: [string, RegExp][] = [
  ['anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['github classic PAT', /ghp_[A-Za-z0-9]{30,}/g],
  ['github fine-grained PAT', /github_pat_[A-Za-z0-9_]{20,}/g],
  ['autopia key', /ak_[0-9A-Za-z]{40}/g],
  ['bearer token (non-placeholder)', /bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi],
  ['x-api-key value (non-placeholder)', /"x-api-key"\s*:\s*"[^"]{12,}"/gi],
  ['postgres url with password', /postgres(ql)?:\/\/[^\s'"]+:[^\s'"@]+@/g],
  ['aws access key', /AKIA[0-9A-Z]{16}/g],
];

const mask = (s: string) => (s.length <= 14 ? s.slice(0, 4) + '***' : s.slice(0, 10) + '***' + s.slice(-4));

async function main() {
  const db = await getDb();
  const tables: [string, string][] = [
    ['trials.input', `select id, input::text as t from trials`],
    ['trials.response', `select id, response::text as t from trials`],
    ['claims.statement', `select id, statement as t from claims`],
    ['target_requests.target', `select id, target::text as t from target_requests`],
    ['contributions', `select id, bundle::text as t from contributions`],
  ];
  let total = 0;
  for (const [label, query] of tables) {
    let rows: { id: number; t: string }[];
    try {
      const r = await db.execute(sql.raw(query));
      rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as { id: number; t: string }[];
    } catch (e) {
      console.log(`${label}: skipped (${(e as Error).message.split('\n')[0]})`);
      continue;
    }
    const hits: Record<string, { count: number; ids: number[]; sample: string }> = {};
    for (const row of rows) {
      const text = row.t ?? '';
      for (const [kind, re] of PATTERNS) {
        for (const m of text.matchAll(re)) {
          if (ALLOW.test(m[0])) continue;
          const h = (hits[kind] ??= { count: 0, ids: [], sample: mask(m[0]) });
          h.count++;
          if (h.ids.length < 5) h.ids.push(row.id);
        }
      }
    }
    const kinds = Object.entries(hits);
    total += kinds.reduce((n, [, h]) => n + h.count, 0);
    console.log(`${label}: ${rows.length} rows scanned, ${kinds.length ? '' : 'no hits'}`);
    for (const [kind, h] of kinds) console.log(`  !! ${kind}: ${h.count} hit(s), e.g. rows ${h.ids.join(',')} -> ${h.sample}`);
  }
  console.log(total ? `\n${total} credential-shaped value(s) stored. Fix before going public.` : '\nNo credential-shaped values stored.');
  await closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
