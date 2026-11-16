import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { requestEstimatorPlan } from '../../src/host/estimator-model.ts';
import { defaultPluginConfig, validatePluginConfig } from '../../src/host/config.ts';

type Chunk = { type: string; text?: string };
function contextWith(service: unknown): Context {
  return { get: (name: string) => name === 'llm' ? service : undefined } as unknown as Context;
}
const settings = { provider: 'provider-a', model: 'model-a', timeoutMs: 5_000 };

test('a complete numeric reply becomes the plan and nothing else is returned', async () => {
  const reply = '{"remainingCalls":{"low":3,"high":7},"remainingOutputTokens":{"low":1200,"high":4000},"remainingToolSeconds":{"low":30,"high":200},"stage":"planning"}';
  let seen: unknown = null;
  const ctx = contextWith({ stream: (options: unknown) => { seen = options; return (async function* () {
    yield { type: 'text-delta', index: 0, text: reply.slice(0, 20) };
    yield { type: 'text-delta', index: 0, text: reply.slice(20) };
    yield { type: 'finish' };
  })(); } });
  const plan = await requestEstimatorPlan(ctx, settings, '重构结算页');
  assert.deepEqual(plan, { remainingCalls: { low: 3, high: 7 }, remainingOutputTokens: { low: 1200, high: 4000 }, remainingToolSeconds: { low: 30, high: 200 }, stage: 'planning' });
  const request = seen as { purpose?: string; messages: Array<{ content: Array<{ text: string }> }> };
  assert.equal(request.purpose, 'task-estimate', 'the call declares its auxiliary purpose');
  assert.match(request.messages[0]!.content[0]!.text, /重构结算页/, 'the task text is what the model sees');
});

test('a missing service, missing route or empty task never calls anything', async () => {
  let calls = 0;
  const ctx = contextWith({ stream: () => { calls += 1; return (async function* () {})(); } });
  assert.equal(await requestEstimatorPlan(ctx, settings, ''), null);
  assert.equal(await requestEstimatorPlan(ctx, { ...settings, provider: '' }, '任务'), null);
  assert.equal(await requestEstimatorPlan(ctx, { ...settings, model: '  ' }, '任务'), null);
  assert.equal(await requestEstimatorPlan(contextWith(undefined), settings, '任务'), null);
  assert.equal(calls, 0);
});

test('a malformed or oversized reply keeps the template forecast', async () => {
  for (const reply of ['{"remainingCalls":{"low":9,"high":2}}', 'no json here', '{"unknown":1}', 'x'.repeat(2_500)]) {
    const ctx = contextWith({ stream: () => (async function* () { yield { type: 'text-delta', text: reply }; yield { type: 'finish' }; })() });
    assert.equal(await requestEstimatorPlan(ctx, settings, '任务'), null, reply.slice(0, 24));
  }
});

test('a hanging call is aborted at the timeout and yields no plan', async () => {
  const ctx = contextWith({ stream: (options: { signal?: AbortSignal }) => (async function* () {
    yield { type: 'text-delta', text: '{"remainingCalls"' };
    await new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  })() });
  const started = Date.now();
  const plan = await requestEstimatorPlan(ctx, { ...settings, timeoutMs: 1_000 }, '任务');
  assert.equal(plan, null);
  assert.ok(Date.now() - started < 5_000, 'the caller waits for the timeout, not forever');
});

test('the estimator stays off and needs an explicit route when enabled', () => {
  const defaults = defaultPluginConfig();
  assert.equal(defaults.estimatorModel.enabled, false, 'no extra model call unless enabled');
  assert.equal(defaults.estimatorModel.provider, '');
  assert.throws(() => validatePluginConfig({ ...defaults, estimatorModel: { enabled: true } }), /provider and model/);
  const enabled = validatePluginConfig({ ...defaults, estimatorModel: { enabled: true, provider: 'provider-a', model: 'model-a' } });
  assert.equal(enabled.estimatorModel.enabled, true);
  assert.equal(enabled.estimatorModel.timeoutMs, 20_000);
});
