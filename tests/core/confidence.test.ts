import test from 'node:test';
import assert from 'node:assert/strict';
import { allowsPointEstimate, forecastConfidence, rangeRatio } from '../../src/shared/confidence.ts';

test('an early forecast is not allowed to claim a single number', () => {
  // The reported bug: a long task that opened with "about 2 minutes".
  const early = forecastConfidence({ hasRemaining: true, hasPlan: false, localSamples: 0, completedCalls: 1, rangeRatio: 6.4 });
  assert.equal(early, 'preliminary');
  assert.equal(allowsPointEstimate(early), false, 'a six-fold range may not collapse to one number');
});

test('confidence rises only with local evidence and a narrow range', () => {
  assert.equal(forecastConfidence({ hasRemaining: true, hasPlan: true, localSamples: 0, completedCalls: 2, rangeRatio: 1.5 }), 'preliminary');
  assert.equal(forecastConfidence({ hasRemaining: true, hasPlan: true, localSamples: 3, completedCalls: 3, rangeRatio: 2.0 }), 'calibrated');
  assert.equal(forecastConfidence({ hasRemaining: true, hasPlan: true, localSamples: 8, completedCalls: 6, rangeRatio: 1.8 }), 'stable');
  assert.equal(allowsPointEstimate('calibrated'), false, 'calibrated still shows a range');
});

test('wide ranges and missing forecasts never become stable', () => {
  assert.equal(forecastConfidence({ hasRemaining: true, hasPlan: true, localSamples: 20, completedCalls: 30, rangeRatio: 3.1 }), 'preliminary');
  assert.equal(forecastConfidence({ hasRemaining: true, hasPlan: true, localSamples: 20, completedCalls: 30, rangeRatio: null }), 'preliminary');
  assert.equal(forecastConfidence({ hasRemaining: false, hasPlan: false, localSamples: 0, completedCalls: 0, rangeRatio: null }), 'assessing');
});

test('the range ratio ignores a zero lower bound instead of dividing by zero', () => {
  assert.ok(rangeRatio({ low: 0, high: 60_000 })! > 1_000, 'a zero floor yields an effectively unbounded ratio');
  assert.equal(rangeRatio({ low: 60_000, high: 180_000 }), 3);
  assert.equal(rangeRatio(null), null);
  assert.equal(rangeRatio({ low: 10, high: 0 }), null);
});
