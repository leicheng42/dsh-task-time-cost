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
