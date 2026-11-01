/** Delay before retry number `attempt` (1-based): base, 2×base, 4×base... capped at `maxMs`. */
export function exponentialBackoff(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export function addMilliseconds(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}
