import test from 'node:test';
import assert from 'node:assert/strict';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { aiPlanSchema, applyAiPlan, readAiPlanResult } from '../../src/shared/ai-plan.ts';
import { estimateWorkload } from '../../src/shared/workload.ts';
import { estimateWorkloadTime } from '../../src/shared/time.ts';
import { heuristicPerformance, selectPerformance } from '../../src/shared/performance.ts';
import { foldFacts, initialFacts } from '../../src/host/facts.ts';

const route = { providerId: 'fixture-provider', endpointFingerprint: 'fixture-endpoint', modelId: 'fixture-model', requestMode: 'tool' as const, reasoningEffort: 'normal', serviceTier: 'standard' };
const input = { remainingCalls: { low: 3, high: 5 }, remainingOutputTokens: { low: 1_000, high: 2_000 }, remainingToolSeconds: { low: 60, high: 120 }, stage: 'verification' as const };
const result = JSON.stringify({ kind: 'task-estimate-plan', version: 1, plan: input });

test('nominal AI time uses route centers instead of midpointing multiplied uncertainty bounds', () => {
  const base = estimateWorkload({ prompt: 'modify code', currentInputTokens: 1_000 }, route);
  const plan = applyAiPlan(base, { ...input, afterCalls: 0, submittedAt: 1_000 }, route, 1_000, {});
  const estimate = estimateWorkloadTime(plan, r => selectPerformance(r, [], [{ ...heuristicPerformance(), totalCallMs: 30_000, appliesTo: { providerId: route.providerId, modelId: route.modelId } }]));
  assert.equal(estimate.typicalMs, 210_000, '4 model responses × 30s plus 90s critical-path tool time');
  assert.deepEqual(estimate.remainingMs, { low: 105_000, high: 495_000 }, 'keep the complete uncertainty range');
});

test('AI plan accepts bounded work metadata and rejects inverted or content-bearing input', () => {
  assert.deepEqual(aiPlanSchema.parse(input), input);
  for (const invalid of [
    { ...input, remainingCalls: { low: 5, high: 1 } },
    { ...input, remainingCalls: { low: 1, high: 501 } },
    { ...input, prompt: 'must not be retained' },
    { ...input, remainingOutputTokens: { low: Number.NaN, high: 2_000 } },
  ]) assert.equal(aiPlanSchema.safeParse(invalid).success, false);
  assert.equal(readAiPlanResult('not-json', 2, 1_000), null);
  assert.equal(readAiPlanResult(result.replace('task-estimate-plan', 'another-tool'), 2, 1_000), null);
});

test('AI work remains grounded in the selected route performance and preserves settled positions', () => {
  const base = estimateWorkload({ prompt: 'modify code', currentInputTokens: 1_000 }, route);
  const plan = applyAiPlan(base, { ...input, afterCalls: 20, submittedAt: 1_000 }, route, 1_000, {});
  assert.equal(plan.low.requests.length, 23);
  assert.equal(plan.high.requests.length, 25);
  assert.equal(plan.high.requests[20]!.id, 'request-21');
  assert.ok(plan.reasons.includes('ai-workload-plan-reference'));
  assert.equal(plan.origin, 'heuristic', 'An AI forecast is not a supplier measurement');
  const completedIds = Array.from({ length: 20 }, (_, index) => `request-${index + 1}`);
  const duration = (totalCallMs: number) => estimateWorkloadTime(plan, r => selectPerformance(r, [], [{ ...heuristicPerformance(), totalCallMs, appliesTo: { providerId: route.providerId, modelId: route.modelId } }]),
    { completedIds, config: { referenceLowFactor: 1, referenceHighFactor: 1 } }).remainingMs;
  assert.deepEqual(duration(30_000), { low: 150_000, high: 270_000 });
  assert.deepEqual(duration(60_000), { low: 240_000, high: 420_000 });
});

test('AI output-token budgets convert through visible generation speed without dividing input/cache totals', () => {
  const textRoute = { ...route, requestMode: 'text' as const };
  const base = estimateWorkload({ prompt: 'write', currentInputTokens: 100_000 }, textRoute);
  const duration = (tokens: number) => {
    const plan = applyAiPlan(base, { ...input, afterCalls: 0, submittedAt: 1_000,
      remainingCalls: { low: 1, high: 1 }, remainingOutputTokens: { low: tokens, high: tokens }, remainingToolSeconds: { low: 0, high: 0 } }, textRoute, 100_000, {});
    return estimateWorkloadTime(plan, r => selectPerformance(r, [], [{ ...heuristicPerformance(), firstTextMs: 10_000, visibleTps: 50,
      appliesTo: { providerId: route.providerId, modelId: route.modelId } }]), { config: { referenceLowFactor: 1, referenceHighFactor: 1 } }).remainingMs;
  };
  assert.deepEqual(duration(1_000), { low: 30_000, high: 30_000 });
  assert.deepEqual(duration(2_000), { low: 50_000, high: 50_000 });
});

test('AI plan is reconstructed from its own durable tool result and invalidated by new human scope', () => {
  const header = { id: 'fixture-session', version: 4, createdAt: 0, isSeeded: false } as SessionHeader;
  const event = (type: string, seq: number, time: number, data: unknown) => ({ type, seq, time, data }) as SessionEvent;
  const events = [
    event('turn/start', 0, 1_000, { turn: 1 }),
    event('tool/call', 1, 2_000, { turn: 1, callId: 'plan-call', name: 'task_estimate_plan' }),
    event('tool/result', 2, 3_000, { turn: 1, message: { role: 'tool', toolCallId: 'plan-call', content: [{ type: 'text', text: result }], isError: false } }),
  ];
  const replay = () => events.reduce((state, next) => foldFacts(state, next, () => 'code'), initialFacts(header, 0));
  const state = replay();
  assert.deepEqual(state.tasks['1']!.aiPlan, { ...input, afterCalls: 0, submittedAt: 3_000 });
  assert.deepEqual(replay(), state, 'Replay must recover the same plan without plugin memory');
  const updated = foldFacts(state, event('user/message', 3, 4_000, { source: { kind: 'user' }, content: [{ type: 'text', text: 'also add tests' }] }), () => 'code');
  assert.equal(updated.tasks['1']!.aiPlan, undefined);
  assert.ok(state.tasks['1']!.aiPlan, 'The previous checkpoint remains immutable');
});
