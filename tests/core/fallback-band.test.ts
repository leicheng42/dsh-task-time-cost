import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBandFallback } from '../../src/shared/fallback-band.ts';

test('an exhausted plan still yields a wide band instead of nothing', () => {
  const band = initialBandFallback({ low: 6_290_304, high: 66_550_304 }, 6_000_000);
  assert.ok(band);
  assert.equal(band!.reason, 'initial-band-fallback');
  assert.ok(band!.low >= 60_000);
  assert.ok(band!.high > band!.low, 'the band stays a band');
  assert.equal(band!.low, 290_304, 'what is left of the initial lower bound');
});

test('the band never collapses when the initial estimate is already spent', () => {
  const band = initialBandFallback({ low: 600_000, high: 900_000 }, 3_000_000);
  assert.ok(band);
  assert.equal(band!.low, 60_000, 'a running turn never claims under a minute');
  assert.ok(band!.high >= 1_500_000, 'half the elapsed time keeps the band honest');
});

test('no band before evidence exists or without an initial estimate', () => {
  assert.equal(initialBandFallback(null, 600_000), null);
  assert.equal(initialBandFallback({ low: 1, high: 2 }, 60_000), null, 'under five minutes a band would be noise');
});

test('without any recorded initial estimate the elapsed time still yields a labelled band', async () => {
  const { elapsedOnlyBand } = await import('../../src/shared/fallback-band.ts');
  const band = elapsedOnlyBand(2 * 3_600_000 + 12 * 60_000);
  assert.ok(band);
  assert.equal(band!.reason, 'elapsed-only-band');
  assert.ok(band!.low >= 30 * 60_000, 'two hours implies more than half an hour to go');
  assert.ok(band!.high >= band!.low * 2);
  assert.equal(elapsedOnlyBand(60_000), null, 'a minute of work proves nothing');
});

test('an already-spent initial estimate falls through to the elapsed band', async () => {
  const { chooseFallbackBand } = await import('../../src/shared/fallback-band.ts');
  // Twelve minutes in, a seven-minute initial total has nothing left to say.
  const band = chooseFallbackBand({ low: 0, high: 7 * 60_000 }, 12 * 60_000);
  assert.ok(band);
  assert.equal(band!.reason, 'elapsed-only-band');
  assert.ok(band!.low >= 3 * 60_000, 'a quarter of the elapsed time is the floor');
  const withInitial = chooseFallbackBand({ low: 20 * 60_000, high: 60 * 60_000 }, 10 * 60_000);
  assert.equal(withInitial!.reason, 'initial-band-fallback', 'a meaningful remainder still wins');
});
