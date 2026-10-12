/**
 * In-memory per-IP limiter for anonymous reads: a per-minute and a per-day count per address,
 * plus one global daily cap as the circuit breaker for the free tiers underneath. Resets on
 * restart, which is fine: the point is to bound abuse, not to meter.
 */
export class AnonLimiter {
  private minute = new Map<string, { until: number; n: number }>();
  private day = new Map<string, { until: number; n: number }>();
  private global = { until: 0, n: 0 };
  constructor(
    public readonly perMinute: number,
    public readonly perDay: number,
    public readonly dailyCap: number,
  ) {}
  take(ip: string, now = Date.now()): { ok: true } | { ok: false; reason: string; retryAfterSeconds: number } {
    const bump = (m: Map<string, { until: number; n: number }>, windowMs: number) => {
      let e = m.get(ip);
      if (!e || e.until <= now) {
        e = { until: now + windowMs, n: 0 };
        m.set(ip, e);
        if (m.size > 50_000) for (const [k, v] of m) if (v.until <= now) m.delete(k); // opportunistic sweep
      }
      e.n++;
      return e;
    };
    if (this.global.until <= now) this.global = { until: now + 86_400_000, n: 0 };
    this.global.n++;
    if (this.global.n > this.dailyCap) return { ok: false, reason: 'anonymous read capacity for today is used up', retryAfterSeconds: Math.ceil((this.global.until - now) / 1000) };
    const d = bump(this.day, 86_400_000);
    if (d.n > this.perDay) return { ok: false, reason: `anonymous daily limit (${this.perDay}) reached for this address`, retryAfterSeconds: Math.ceil((d.until - now) / 1000) };
    const mnt = bump(this.minute, 60_000);
    if (mnt.n > this.perMinute) return { ok: false, reason: `anonymous rate limit (${this.perMinute}/min) reached for this address`, retryAfterSeconds: Math.ceil((mnt.until - now) / 1000) };
    return { ok: true };
  }
}
