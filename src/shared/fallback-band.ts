/**
 * When nothing else can produce a number, the initial estimate minus what has
 * already been spent is still a defensible band: it says "the early total said
 * this much, here is what is left of it". It is deliberately wide and must be
 * labelled as a fallback, never presented as a fresh plan.
 */
export function initialBandFallback(
  initial: { low: number; high: number } | null,
  elapsedMs: number,
): { low: number; high: number; reason: string } | null {
  if (!initial || !Number.isFinite(initial.low) || !Number.isFinite(initial.high)) return null;
  if (elapsedMs < 300_000) return null;
  const remainingLow = Math.max(60_000, initial.low - elapsedMs);
  const remainingHigh = Math.max(remainingLow * 2, initial.high - elapsedMs, elapsedMs * 0.5);
  return { low: Math.round(remainingLow), high: Math.round(remainingHigh), reason: 'initial-band-fallback' };
}
