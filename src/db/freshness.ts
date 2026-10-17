/**
 * FRESHNESS. Every claim records when its evidence last reproduced (verified_at). Sheets and
 * records say how old that is, so an agent can weigh a fact that was re-verified this morning
 * differently from one nobody has re-run for weeks (a target whose nightly run keeps failing, or
 * a contributor-tier tool that is never re-run here).
 */
/** Nightly cadence: one missed night is routine, two is suspicious, three is a pattern. */
export const STALE_DAYS = 3;

/** A run that kept fewer than half the previous successful run's claims lost coverage; the missing behaviors were not re-checked, not disproved. */
export function coverageDropped(current: number, previous: number | null): boolean {
  return previous !== null && previous >= 10 && current < previous / 2;
}

/** Whole UTC calendar days between the two instants (never negative), so "today" agrees with the printed UTC date. */
export function ageDays(verifiedAt: Date | string, now: Date = new Date()): number {
  const v = new Date(verifiedAt);
  const day = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return Math.max(0, Math.round((day(now) - day(v)) / 86_400_000));
}

export function ageText(days: number): string {
  return days === 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`;
}
