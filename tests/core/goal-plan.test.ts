import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../../src/shared/goal-plan.ts';

const minutes = (value: number) => value * 60_000;

test('a goal plan multiplies the remaining rounds by the observed round durations', () => {
  const plan = planGoal({
    started: 4,
    max: 10,
    rounds: [{ elapsedMs: minutes(10) }, { elapsedMs: minutes(14) }, { elapsedMs: minutes(12) }, { elapsedMs: minutes(20) }],
  });
  assert.equal(plan.roundsLeft, 6);
  assert.equal(plan.observed, 4);
  assert.equal(plan.medianRoundMs, minutes(13));
  assert.equal(plan.lowMs, minutes(72), 'quick quartile (12 min) × the remaining rounds');
  assert.equal(plan.highMs, minutes(84), 'slow quartile (14 min) × the remaining rounds');
  assert.ok(plan.lowMs! <= plan.medianRoundMs! * 6 && plan.medianRoundMs! * 6 <= plan.highMs!);
});

test('too few observations widen the slow bound instead of pretending precision', () => {
  const plan = planGoal({ started: 1, max: 5, rounds: [{ elapsedMs: minutes(10) }] });
  assert.equal(plan.medianRoundMs, minutes(10));
  assert.equal(plan.lowMs, minutes(40), 'one round, four left');
  assert.equal(plan.highMs, minutes(60), 'a single sample is inflated by half before being multiplied');
});

test('no finished round means no goal estimate yet', () => {
  const plan = planGoal({ started: 1, max: 5, rounds: [] });
  assert.deepEqual(plan, { roundsLeft: 4, observed: 0, medianRoundMs: null, lowMs: null, highMs: null });
});

test('an exhausted budget reports zero rounds left and no forward estimate', () => {
  const plan = planGoal({ started: 5, max: 5, rounds: [{ elapsedMs: minutes(10) }, { elapsedMs: minutes(12) }] });
  assert.equal(plan.roundsLeft, 0);
  assert.equal(plan.lowMs, null);
  assert.equal(plan.highMs, null);
  assert.equal(plan.medianRoundMs, minutes(11));
});

test('rounds below a minute are floored so the range never promises seconds', () => {
  const plan = planGoal({ started: 0, max: 2, rounds: [{ elapsedMs: 5_000 }, { elapsedMs: 8_000 }] });
  assert.equal(plan.lowMs, minutes(2), 'two rounds, each floored at one minute');
  assert.equal(plan.highMs, minutes(2), 'the high bound never drops below the low bound');
});
