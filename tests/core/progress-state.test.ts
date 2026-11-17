import test from 'node:test';
import assert from 'node:assert/strict';
import { progressState } from '../../src/shared/progress-state.ts';

test('a missing forecast is "unknown", never a claim that the task is late', () => {
  assert.equal(progressState({ ended: false, elapsedMs: 600_000, remainingHighMs: null, trail: [], completedCalls: 40 }).state, 'unknown');
  assert.equal(progressState({ ended: false, elapsedMs: 2_000, remainingHighMs: null, trail: [], completedCalls: 0 }).state, 'starting');
});

test('the state reports direction, not only a number', () => {
  const base = { ended: false, elapsedMs: 120_000, completedCalls: 12 };
  assert.equal(progressState({ ...base, remainingHighMs: 600_000, trail: [900_000, 600_000] }).state, 'faster');
  assert.equal(progressState({ ...base, remainingHighMs: 900_000, trail: [500_000, 900_000] }).state, 'slower');
  assert.equal(progressState({ ...base, remainingHighMs: 800_000, trail: [800_000, 800_000] }).state, 'onTrack');
  assert.equal(progressState({ ...base, remainingHighMs: 40_000, trail: [40_000] }).state, 'finishing');
});

test('a finished turn stops predicting and reports the fact', () => {
  assert.equal(progressState({ ended: true, elapsedMs: 700_000, remainingHighMs: null, trail: [], completedCalls: 30 }).state, 'done');
});

test('the trend ratio is exposed for wording, and single samples stay neutral', () => {
  assert.equal(progressState({ ended: false, elapsedMs: 1_000, remainingHighMs: 600_000, trail: [300_000, 600_000], completedCalls: 3 }).trendRatio, 2);
  assert.equal(progressState({ ended: false, elapsedMs: 1_000, remainingHighMs: 600_000, trail: [600_000], completedCalls: 3 }).trendRatio, null);
});
