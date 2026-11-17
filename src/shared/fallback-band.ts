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

/**
 * Even without a recorded initial estimate the elapsed time is evidence: a turn
 * that has already run for two hours is not "almost done", and staying blank is
 * worse than saying "at least this much longer". Wide on purpose, always labelled.
 */
export function elapsedOnlyBand(elapsedMs: number): { low: number; high: number; reason: string } | null {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 300_000) return null;
  const low = Math.max(60_000, Math.round(elapsedMs * 0.25));
  return { low, high: Math.max(low * 2, Math.round(elapsedMs)), reason: 'elapsed-only-band' };
}

/**
 * Pick the wider of the two last resorts. When the initial estimate is already
 * spent, its remainder collapses onto the one-minute floor and says nothing, so
 * the elapsed-time band is the honest choice.
 */
export function chooseFallbackBand(
  initial: { low: number; high: number } | null,
  elapsedMs: number,
): { low: number; high: number; reason: string } | null {
  const fromInitial = initialBandFallback(initial, elapsedMs);
  const fromElapsed = elapsedOnlyBand(elapsedMs);
  if (fromInitial && fromInitial.low > 60_000) {
    const high = fromElapsed ? Math.max(fromInitial.high, fromElapsed.high) : fromInitial.high;
    return { low: fromInitial.low, high, reason: fromInitial.reason };
  }
  return fromElapsed;
}
