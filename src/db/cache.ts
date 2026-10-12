/**
 * In-memory TTL memo for read responses. Claims change only when a run writes them (nightly), so
 * serving a rendered sheet or the catalogue from memory for a few minutes costs nothing in
 * freshness and keeps anonymous traffic off the database: the free tiers underneath (Render,
 * Neon) are billed in compute time, and a cached hit uses none of Neon's.
 *
 * Concurrent misses for the same key share one computation.
 */
const store = new Map<string, { until: number; value: Promise<unknown> }>();

export const DEFAULT_TTL_MS = Number(process.env.AUTOPIA_CACHE_TTL_MS ?? 10 * 60 * 1000);

export function memo<T>(key: string, fn: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.until > now) return hit.value as Promise<T>;
  const value = fn().catch((e) => {
    store.delete(key); // never cache a failure
    throw e;
  });
  store.set(key, { until: now + ttlMs, value });
  if (store.size > 5_000) for (const [k, v] of store) if (v.until <= now) store.delete(k);
  return value;
}

export function memoClear(): void {
  store.clear();
}

export function memoSize(): number {
  return store.size;
}
