import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCallSizePerformance } from '../../src/shared/call-size.ts';
import { selectPerformance } from '../../src/shared/performance.ts';
import { estimateRequestTime } from '../../src/shared/time.ts';
import type { RequestBudget } from '../../src/shared/workload.ts';

const route = { providerId: 'fixture-provider', endpointFingerprint: 'fixture-endpoint', modelId: 'fixture-model', requestMode: 'tool' as const, reasoningEffort: 'normal', serviceTier: 'standard' };
const request: RequestBudget = { id: 'future', route, inputTokens: { low: 1_000, high: 1_000 }, visibleOutputTokens: { low: 8_000, high: 12_000 }, visibleTextTokens: null, reasoningTokens: null, cacheReadRatio: { low: 0.5, high: 0.5 }, sourceKind: 'heuristic', dependsOn: [] };
const base = selectPerformance(route, []);
const samples = [
  ...Array.from({ length: 10 }, () => ({ route, inputTokens: 1_000, visibleOutputTokens: 200, cacheReadRatio: 0.5, durationMs: 30_000 })),
  ...Array.from({ length: 5 }, () => ({ route, inputTokens: 1_000, visibleOutputTokens: 10_000, cacheReadRatio: 0.5, durationMs: 180_000 })),
];

test('token-scale matching keeps large tool generations out of the small-call duration bucket', () => {
  const selected = selectCallSizePerformance(request, base, samples, 5);
  assert.equal(selected.samples, 5);
  assert.ok(selected.reasons.includes('size-matched-call-duration-reference'));
  assert.deepEqual(estimateRequestTime(request, selected).remainingMs, { low: 180_000, high: 180_000 });
  const small = { ...request, visibleOutputTokens: { low: 150, high: 250 } };
  assert.deepEqual(estimateRequestTime(small, selectCallSizePerformance(small, base, samples, 5)).remainingMs, { low: 30_000, high: 30_000 });
});

test('incompatible routes, input sizes, cache rates or unknown output do not manufacture matched samples', () => {
  for (const changed of [
    { ...request, route: { ...route, modelId: 'another-model' } },
    { ...request, inputTokens: { low: 100_000, high: 100_000 } },
    { ...request, cacheReadRatio: { low: 0.9, high: 0.9 } },
  ]) {
    const selected = selectCallSizePerformance(changed, base, samples, 5);
    assert.deepEqual(selected.totalCallSamplesMs, base.totalCallSamplesMs);
    assert.ok(selected.reasons.includes('size-matched-samples-insufficient'));
  }
  const unknown = samples.map(sample => ({ ...sample, visibleOutputTokens: null }));
  assert.ok(selectCallSizePerformance(request, base, unknown, 5).reasons.includes('size-matched-samples-insufficient'));
});
