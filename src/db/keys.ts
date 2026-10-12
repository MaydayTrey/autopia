/**
 * Per-user API keys for the HTTP MCP server, plus the usage log.
 *
 *   key format   ak_<40 base62 chars>; shown ONCE at creation
 *   storage      sha256 hex of the key; prefix (ak_ + 6 chars) for display
 *   auth         verifyKey(): hash lookup, revoked check, per-day quota check
 *   usage        logCall(): one row per MCP tool call (key, tool, target, ok, ms)
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { schema } from './client.js';
import type { ApiKey } from './schema.js';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const KEY_RE = /^ak_[0-9A-Za-z]{40}$/;

export function generateKey(): string {
  const bytes = randomBytes(40);
  let s = 'ak_';
  for (let i = 0; i < 40; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function prefixOf(key: string): string {
  return key.slice(0, 9); // "ak_" + 6
}

export async function createKey(db: Db, name: string, quotaPerDay = 2000): Promise<{ key: string; row: ApiKey }> {
  if (!/^[a-z0-9][a-z0-9-_.@]{1,63}$/i.test(name)) throw new Error('key name must be 2-64 chars: letters, digits, - _ . @');
  const key = generateKey();
  const [row] = await db.insert(schema.apiKeys).values({ name, keyHash: hashKey(key), prefix: prefixOf(key), quotaPerDay }).returning();
  return { key, row };
}

export type VerifyResult = { ok: true; key: ApiKey; callsToday: number } | { ok: false; status: 401 | 429; reason: string };

/** Hash lookup + revocation + quota. Updates last_used_at on success. */
export async function verifyKey(db: Db, presented: string, now = new Date()): Promise<VerifyResult> {
  if (!KEY_RE.test(presented)) return { ok: false, status: 401, reason: 'malformed key' };
  const [key] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.keyHash, hashKey(presented)));
  if (!key) return { ok: false, status: 401, reason: 'unknown key' };
  if (key.revokedAt) return { ok: false, status: 401, reason: 'key revoked' };
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.apiCalls).where(and(eq(schema.apiCalls.keyId, key.id), gte(schema.apiCalls.createdAt, dayStart)));
  if (Number(n) >= key.quotaPerDay) return { ok: false, status: 429, reason: `daily quota of ${key.quotaPerDay} calls reached` };
  await db.update(schema.apiKeys).set({ lastUsedAt: now }).where(eq(schema.apiKeys.id, key.id));
  return { ok: true, key, callsToday: Number(n) };
}

export type CallIdentity = 'key' | 'admin' | 'anon' | 'open' | 'stdio';

export async function logCall(db: Db, keyId: number | null, tool: string, target: string | null, ok: boolean, ms: number, identity: CallIdentity = keyId === null ? 'admin' : 'key', caller: string | null = null): Promise<void> {
  await db.insert(schema.apiCalls).values({ keyId, identity, caller, tool, target, ok, ms: Math.round(ms) });
}

/** A stable, salted, truncated hash of a client address: enough to count distinct anonymous callers, not enough to recover the address. */
export function callerHash(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}|${ip}`).digest('hex').slice(0, 16);
}

export async function listKeys(db: Db) {
  const keys = await db.select().from(schema.apiKeys).orderBy(schema.apiKeys.id);
  const out = [];
  for (const k of keys) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.apiCalls).where(eq(schema.apiCalls.keyId, k.id));
    out.push({ id: k.id, name: k.name, prefix: k.prefix, quota_per_day: k.quotaPerDay, created_at: k.createdAt, last_used_at: k.lastUsedAt, revoked_at: k.revokedAt, calls: Number(n) });
  }
  return out;
}

/** Revoke by name or prefix. Returns the row or null. */
export async function revokeKey(db: Db, nameOrPrefix: string): Promise<ApiKey | null> {
  const [k] = await db
    .select()
    .from(schema.apiKeys)
    .where(and(isNull(schema.apiKeys.revokedAt), sql`(${schema.apiKeys.name} = ${nameOrPrefix} OR ${schema.apiKeys.prefix} = ${nameOrPrefix})`));
  if (!k) return null;
  const [row] = await db.update(schema.apiKeys).set({ revokedAt: new Date() }).where(eq(schema.apiKeys.id, k.id)).returning();
  return row;
}

/** Calls per key per tool in the last N days, plus which targets are asked about most. */
export async function usageSummary(db: Db, days = 7) {
  const since = new Date(Date.now() - days * 86_400_000);
  const byKeyTool = await db
    .select({ keyId: schema.apiCalls.keyId, identity: schema.apiCalls.identity, name: schema.apiKeys.name, tool: schema.apiCalls.tool, calls: sql<number>`count(*)::int`, errors: sql<number>`sum(case when ${schema.apiCalls.ok} then 0 else 1 end)::int`, avgMs: sql<number>`avg(${schema.apiCalls.ms})::int` })
    .from(schema.apiCalls)
    .leftJoin(schema.apiKeys, eq(schema.apiCalls.keyId, schema.apiKeys.id))
    .where(gte(schema.apiCalls.createdAt, since))
    .groupBy(schema.apiCalls.keyId, schema.apiCalls.identity, schema.apiKeys.name, schema.apiCalls.tool)
    .orderBy(desc(sql`count(*)`));
  // The question behind all of this: how many different people (well, addresses) are using it?
  const [callers] = await db
    .select({
      anonCallers: sql<number>`count(distinct case when ${schema.apiCalls.identity} = 'anon' then ${schema.apiCalls.caller} end)::int`,
      anonCalls: sql<number>`sum(case when ${schema.apiCalls.identity} = 'anon' then 1 else 0 end)::int`,
      keys: sql<number>`count(distinct ${schema.apiCalls.keyId})::int`,
      keyCalls: sql<number>`sum(case when ${schema.apiCalls.identity} = 'key' then 1 else 0 end)::int`,
      adminCalls: sql<number>`sum(case when ${schema.apiCalls.identity} = 'admin' then 1 else 0 end)::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(schema.apiCalls)
    .where(gte(schema.apiCalls.createdAt, since));
  const perDay = await db
    .select({ day: sql<string>`to_char(${schema.apiCalls.createdAt}, 'YYYY-MM-DD')`, calls: sql<number>`count(*)::int`, anonCallers: sql<number>`count(distinct case when ${schema.apiCalls.identity} = 'anon' then ${schema.apiCalls.caller} end)::int` })
    .from(schema.apiCalls)
    .where(gte(schema.apiCalls.createdAt, since))
    .groupBy(sql`to_char(${schema.apiCalls.createdAt}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${schema.apiCalls.createdAt}, 'YYYY-MM-DD')`);
  const byTarget = await db
    .select({ target: schema.apiCalls.target, calls: sql<number>`count(*)::int` })
    .from(schema.apiCalls)
    .where(and(gte(schema.apiCalls.createdAt, since), sql`${schema.apiCalls.target} is not null`))
    .groupBy(schema.apiCalls.target)
    .orderBy(desc(sql`count(*)`))
    .limit(20);
  const label = (r: { keyId: number | null; identity: string; name: string | null }) => r.name ?? (r.identity === 'anon' ? 'anonymous' : r.identity === 'admin' ? 'admin-token' : r.identity === 'open' ? 'open-endpoint' : r.keyId === null ? r.identity : `#${r.keyId}`);
  return { since, byKeyTool: byKeyTool.map((r) => ({ ...r, name: label(r) })), byTarget, callers: { ...callers, keys: callers.keys ?? 0 }, perDay };
}
