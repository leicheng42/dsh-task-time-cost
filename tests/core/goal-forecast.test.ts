import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoalPrompt, parseGoalPlan } from '../../src/shared/estimator-model.ts';

test('the goal prompt asks for a minute range and reports observed progress', () => {
  const prompt = buildGoalPrompt('Ship the checkout flow', { elapsedMs: 47 * 60_000, roundsDone: 6, toolsDone: 90 });
  assert.match(prompt, /47 minutes of active work/);
  assert.match(prompt, /6 rounds finished, 90 tool calls/);
  assert.match(prompt, /"remainingMinutes":\{"low":N,"high":N\}/);
  assert.match(prompt, /Ship the checkout flow/);
});

test('a previous answer is carried forward so the range cannot swing wildly', () => {
  const prompt = buildGoalPrompt('Ship it', { elapsedMs: 0, roundsDone: 2, toolsDone: 4, previous: { lowMs: 30 * 60_000, highMs: 90 * 60_000 } });
  assert.match(prompt, /Previous estimate for this goal: 30-90 minutes/);
});

test('only a complete in-range minute range survives parsing', () => {
  assert.deepEqual(parseGoalPlan('{"remainingMinutes":{"low":90,"high":240}}'), { lowMs: 90 * 60_000, highMs: 240 * 60_000 });
  assert.deepEqual(parseGoalPlan('sure: {"remainingMinutes":{"low":1,"high":1}}'), { lowMs: 60_000, highMs: 60_000 });
  assert.equal(parseGoalPlan('{"remainingMinutes":{"low":0,"high":10}}'), null, 'zero minutes is not an estimate');
  assert.equal(parseGoalPlan('{"remainingMinutes":{"low":90,"high":30}}'), null, 'inverted range is refused');
  assert.equal(parseGoalPlan('{"remainingMinutes":{"low":1,"high":99999}}'), null, 'a week is the ceiling');
  assert.equal(parseGoalPlan('{"remainingMinutes":{"low":1.6,"high":"20"}}'), null, 'strings and fractions are refused');
  assert.equal(parseGoalPlan('I think about two hours.'), null, 'prose is not a plan');
});
