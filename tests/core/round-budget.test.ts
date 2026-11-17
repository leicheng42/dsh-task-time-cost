import test from 'node:test';
import assert from 'node:assert/strict';
import { capByRoundBudget } from '../../src/shared/round-budget.ts';

test('a goal cannot be forecast beyond its remaining round budget', () => {
  // 3 rounds left at 10 minutes each: the clock may say hours, the budget says 30m.
  const result = capByRoundBudget({ low: 40 * 60_000, high: 3 * 3_600_000 }, { started: 8, max: 10 }, 10 * 60_000);
  assert.deepEqual(result.remaining, { low: 16 * 60_000, high: 20 * 60_000 });
  assert.ok(result.reasons.includes('goal-round-budget-capped'));
  assert.ok(result.reasons.includes('goal-round-budget-close'), 'two rounds left is worth warning about');
});

test('a range inside the budget is left alone', () => {
  const range = { low: 60_000, high: 5 * 60_000 };
  const result = capByRoundBudget(range, { started: 2, max: 30 }, 10 * 60_000);
  assert.equal(result.remaining, range);
  assert.deepEqual(result.reasons, []);
});

test('a spent budget is reported even without a forecast', () => {
  assert.deepEqual(capByRoundBudget(null, { started: 30, max: 30 }, 600_000), { remaining: null, reasons: ['goal-round-budget-spent'] });
  assert.deepEqual(capByRoundBudget(null, { started: 29, max: 30 }, 600_000), { remaining: null, reasons: ['goal-round-budget-close'] });
});

test('no goal budget means no cap', () => {
  const range = { low: 1, high: 2 };
  assert.deepEqual(capByRoundBudget(range, null, 1_000), { remaining: range, reasons: [] });
});
