import test from 'node:test';
import assert from 'node:assert/strict';
import { ESTIMATOR_PROMPT_LIMIT, ESTIMATOR_REPLY_LIMIT, buildEstimatorPrompt, parseEstimatorPlan } from '../../src/shared/estimator-model.ts';

test('the estimator prompt carries the task text bounded and states the exact numeric contract', () => {
  const prompt = buildEstimatorPrompt('修复登录页的重复提交');
  assert.match(prompt, /修复登录页的重复提交/);
  assert.match(prompt, /remainingCalls/);
  assert.match(prompt, /JSON object and nothing else/);
  const long = buildEstimatorPrompt('x'.repeat(ESTIMATOR_PROMPT_LIMIT + 500));
  assert.ok(long.length < ESTIMATOR_PROMPT_LIMIT + 1_200, 'the task text is truncated');
  assert.equal(buildEstimatorPrompt('   '), buildEstimatorPrompt(''), '空白任务不改变结构');
});

test('a model reply is accepted only as a complete in-range numeric plan', () => {
  const plan = parseEstimatorPlan('```json\n{"remainingCalls":{"low":4,"high":9},"remainingOutputTokens":{"low":2000,"high":6000},"remainingToolSeconds":{"low":60,"high":240},"stage":"implementation"}\n```');
  assert.deepEqual(plan, { remainingCalls: { low: 4, high: 9 }, remainingOutputTokens: { low: 2000, high: 6000 }, remainingToolSeconds: { low: 60, high: 240 }, stage: 'implementation' });
  assert.equal(parseEstimatorPlan('not json'), null);
  assert.equal(parseEstimatorPlan('{"remainingCalls":{"low":9,"high":4}}'), null, '倒置区间被拒');
  assert.equal(parseEstimatorPlan('{"remainingCalls":{"low":1,"high":2},"extra":true}'), null, '未知字段被拒');
  assert.equal(parseEstimatorPlan('{"remainingCalls":{"low":0,"high":2}}'), null, '0 轮调用被拒');
  assert.equal(parseEstimatorPlan('x'.repeat(ESTIMATOR_REPLY_LIMIT + 1)), null, '超长回复不解析');
});
