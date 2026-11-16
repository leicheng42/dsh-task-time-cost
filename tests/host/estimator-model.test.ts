import test from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@deepseek-ai/cordis';
import { requestEstimatorPlan } from '../../src/host/estimator-model.ts';
import { defaultPluginConfig, validatePluginConfig } from '../../src/host/config.ts';
import { resolveEstimatorRoute } from '../../src/shared/estimator-model.ts';

function contextWith(service: unknown): Context {
  return { get: (name: string) => name === 'llm' ? service : undefined } as unknown as Context;
}
const providers = [{ id: 'provider-a', name: 'A' }];
const session = { providerId: 'provider-a', modelId: 'model-a' };
const settings = { provider: '', model: '', timeoutMs: 5_000 };

test('an empty override follows the session route, so nothing has to be configured', async () => {
  const reply = '{"remainingCalls":{"low":3,"high":7},"remainingOutputTokens":{"low":1200,"high":4000},"remainingToolSeconds":{"low":30,"high":200},"stage":"planning"}';
  let seen: { provider?: string; model?: string; purpose?: string; messages: Array<{ content: Array<{ text: string }> }> } | null = null;
  const ctx = contextWith({ listProviders: () => providers, stream: (options: typeof seen) => { seen = options; return (async function* () {
    yield { type: 'text-delta', index: 0, text: reply.slice(0, 20) };
    yield { type: 'text-delta', index: 0, text: reply.slice(20) };
    yield { type: 'finish' };
  })(); } });
  const plan = await requestEstimatorPlan(ctx, settings, session, '重构结算页');
  assert.deepEqual(plan, { remainingCalls: { low: 3, high: 7 }, remainingOutputTokens: { low: 1200, high: 4000 }, remainingToolSeconds: { low: 30, high: 200 }, stage: 'planning' });
  assert.equal(seen!.provider, 'provider-a', 'the call uses the session provider');
  assert.equal(seen!.model, 'model-a', 'the call uses the session model');
  assert.equal(seen!.purpose, 'task-estimate');
  assert.match(seen!.messages[0]!.content[0]!.text, /重构结算页/);
});

test('an explicit override wins, and one half of an override is refused', async () => {
  const used: string[] = [];
  const ctx = contextWith({ listProviders: () => providers, stream: (options: { provider: string }) => { used.push(options.provider); return (async function* () {
    yield { type: 'text-delta', text: '{"remainingCalls":{"low":1,"high":2},"remainingOutputTokens":{"low":1,"high":2},"remainingToolSeconds":{"low":1,"high":2},"stage":"planning"}' };
  })(); } });
  await requestEstimatorPlan(ctx, { ...settings, provider: 'other', model: 'other-model' }, session, '任务');
  assert.deepEqual(used, ['other']);
  // 保存时已经拒绝半配置；运行期若真出现，也只退回会话路由而不是乱选。
  assert.deepEqual(await requestEstimatorPlan(ctx, { ...settings, provider: 'other' }, session, '任务'),
    { remainingCalls: { low: 1, high: 2 }, remainingOutputTokens: { low: 1, high: 2 }, remainingToolSeconds: { low: 1, high: 2 }, stage: 'planning' });
  assert.deepEqual(used, ['other', 'provider-a'], '半配置退回会话 provider');
});

test('no service, no model or no task text never calls anything', async () => {
  let calls = 0;
  const ctx = contextWith({ listProviders: () => providers, stream: () => { calls += 1; return (async function* () {})(); } });
  assert.equal(await requestEstimatorPlan(ctx, settings, session, ''), null);
  assert.equal(await requestEstimatorPlan(ctx, settings, { providerId: 'provider-a', modelId: null }, '任务'), null);
  assert.equal(await requestEstimatorPlan(ctx, settings, { providerId: 'unknown', modelId: 'model-a' }, '任务'), null);
  assert.equal(await requestEstimatorPlan(contextWith(undefined), settings, session, '任务'), null);
  assert.equal(calls, 0);
});

test('a malformed or oversized reply keeps the template forecast', async () => {
  for (const reply of ['{"remainingCalls":{"low":9,"high":2}}', 'no json here', '{"unknown":1}', 'x'.repeat(2_500)]) {
    const ctx = contextWith({ listProviders: () => providers, stream: () => (async function* () { yield { type: 'text-delta', text: reply }; yield { type: 'finish' }; })() });
    assert.equal(await requestEstimatorPlan(ctx, settings, session, '任务'), null, reply.slice(0, 24));
  }
});

test('a hanging call is aborted at the timeout and yields no plan', async () => {
  const ctx = contextWith({ listProviders: () => providers, stream: (options: { signal?: AbortSignal }) => (async function* () {
    yield { type: 'text-delta', text: '{"remainingCalls"' };
    await new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  })() });
  const started = Date.now();
  assert.equal(await requestEstimatorPlan(ctx, { ...settings, timeoutMs: 1_000 }, session, '任务'), null);
  assert.ok(Date.now() - started < 5_000, 'the caller waits for the timeout, not forever');
});

test('the estimator is on by default and follows the session unless overridden', () => {
  const defaults = defaultPluginConfig();
  assert.equal(defaults.estimatorModel.enabled, true, 'the model-based estimate is the default');
  assert.equal(defaults.estimatorModel.provider, '', 'no provider has to be named');
  assert.deepEqual(resolveEstimatorRoute(providers, session, { provider: '', model: '' }), { provider: 'provider-a', model: 'model-a', source: 'session-route' });
  assert.equal(resolveEstimatorRoute(providers, { providerId: 'magpie-responses', modelId: 'auto/x' }, { provider: '', model: '' }), null, '未知路由不乱猜');
  assert.deepEqual(resolveEstimatorRoute(providers, { providerId: 'provider-a', modelId: 'model-a' }, { provider: 'p', model: 'm' }), { provider: 'p', model: 'm', source: 'override' });
  assert.equal(resolveEstimatorRoute([{ id: 'only' }], { providerId: '', modelId: 'm' }, { provider: '', model: '' })?.provider, 'only', '单一路由时可省略 provider');
  assert.throws(() => validatePluginConfig({ ...defaults, estimatorModel: { enabled: true, provider: 'only-provider' } }), /both a provider and a model/);
  assert.equal(validatePluginConfig({ ...defaults, estimatorModel: { enabled: false } }).estimatorModel.enabled, false);
});
