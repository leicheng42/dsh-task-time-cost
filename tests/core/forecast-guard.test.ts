import test from 'node:test';
import assert from 'node:assert/strict';
import { forecastCorrection } from '../../src/shared/forecast-guard.ts';

test('a task that runs past its initial bound is corrected, never shown as finished', () => {
  const correction = forecastCorrection({ elapsedActiveMs: 521_000, initialHighMs: 120_000, planRemainingHighMs: 60_000, completedCalls: 531, currentRemainingHighMs: 60_000 });
  assert.equal(correction.correct, true);
  assert.ok(correction.reasons.includes('initial-forecast-exceeded'));
  assert.equal(correction.floorHighMs, 260_500, 'half of the elapsed time is the honest floor');
});

test('a plan that claims a small fraction of the elapsed time is not trusted', () => {
  const correction = forecastCorrection({ elapsedActiveMs: 900_000, initialHighMs: null, planRemainingHighMs: 60_000, completedCalls: 40, currentRemainingHighMs: 60_000 });
  assert.equal(correction.correct, true);
  assert.ok(correction.reasons.includes('plan-below-observed-effort'));
  assert.equal(correction.floorHighMs, 450_000);
});

test('short or well-supported work is left alone', () => {
  const early = forecastCorrection({ elapsedActiveMs: 20_000, initialHighMs: 120_000, planRemainingHighMs: 90_000, completedCalls: 1, currentRemainingHighMs: 90_000 });
  assert.equal(early.correct, false, 'inside the initial bound with a plausible plan');
  const grounded = forecastCorrection({ elapsedActiveMs: 300_000, initialHighMs: null, planRemainingHighMs: 240_000, completedCalls: 20, currentRemainingHighMs: 240_000 });
  assert.equal(grounded.correct, false, 'a plan consistent with the observed pace stands');
});

test('the floor is bounded and never shrinks the current range', () => {
  const tiny = forecastCorrection({ elapsedActiveMs: 10_000, initialHighMs: 5_000, planRemainingHighMs: null, completedCalls: 1, currentRemainingHighMs: 1_000 });
  assert.equal(tiny.correct, true);
  assert.equal(tiny.floorHighMs, 60_000, 'a running turn never claims under a minute');
  const huge = forecastCorrection({ elapsedActiveMs: 40_000_000, initialHighMs: 1_000, planRemainingHighMs: null, completedCalls: 3, currentRemainingHighMs: 1_000 });
  assert.equal(huge.floorHighMs, 3_600_000, 'the floor stops at one hour');
  const wider = forecastCorrection({ elapsedActiveMs: 4_000_000, initialHighMs: 1_000, planRemainingHighMs: null, completedCalls: 3, currentRemainingHighMs: 5_000_000 });
  assert.equal(wider.floorHighMs, 5_000_000, 'an already wider range is never shrunk');
});
