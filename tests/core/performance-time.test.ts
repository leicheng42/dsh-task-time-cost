import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfile, updateProfile, selectPerformance, overallVisibleTps, profileKey, endpointFingerprint, estimateRequestTime, estimatePlanTime, schedule, calculateElapsed } from '../../src/shared/index.ts';
import type { RouteIdentity, CallObservation, PerformancePrior, PerformanceEstimate, PlanScenario, RequestBudget } from '../../src/shared/index.ts';

const route: RouteIdentity = { providerId: 'provider-a', endpointFingerprint: 'endpoint-a', modelId: 'same-model', requestMode: 'text', reasoningEffort: 'high', serviceTier: 'standard' };
const exact = { referenceLowFactor: 1, referenceHighFactor: 1 };
function observation(overrides: Partial<CallObservation> = {}): CallObservation { return { attemptId: 'a', route, startedAtMs: 0, firstContentAtMs: 1_000, firstTextAtMs: 20_000, lastContentAtMs: 23_000, endedAtMs: 23_000, outcome: 'completed', streaming: true, hiddenReasoningSeparable: true, visibleTextTokens: 300, tokenMeasurement: 'reported', timingSource: 'synthetic-test', ...overrides }; }
function prior(overrides: Partial<PerformancePrior> = {}): PerformancePrior { return { id: 'test-prior', sourceKind: 'heuristic', firstContentMs: 1_000, firstTextMs: 20_000, visibleTps: 50, totalCallMs: 30_000, ...overrides }; }
function performance(overrides: Partial<PerformanceEstimate> = {}): PerformanceEstimate { return { firstContentMs: 1_000, firstTextMs: 20_000, visibleTps: 50, totalCallMs: 30_000, sourceKind: 'heuristic', sourceId: 'test', samples: 0, speedSamples: 0, match: 'heuristic', trust: 'reference', metricOrigins: { firstContent: 'heuristic', firstText: 'heuristic', speed: 'heuristic', total: 'heuristic' }, firstTextWaitSamplesMs: [], totalCallSamplesMs: [], reasons: [], ...overrides }; }
function request(overrides: Partial<RequestBudget> = {}): RequestBudget { return { id: 'r', route, inputTokens: { low: 1_000, high: 1_000 }, visibleTextTokens: { low: 300, high: 300 }, visibleOutputTokens: { low: 500, high: 500 }, reasoningTokens: { low: 200, high: 200 }, cacheReadRatio: null, dependsOn: [], sourceKind: 'heuristic', ...overrides }; }

test('T01 four serial calls / 2000 body Tokens / 20s tools gives A=52s B=160s', () => {
  const scenario: PlanScenario = { requests: Array.from({ length: 4 }, (_, index) => request({ id: `r${index}`, visibleTextTokens: { low: 500, high: 500 }, dependsOn: index ? [`r${index - 1}`] : [] })), tools: [{ id: 'tool', durationMs: { low: 20_000, high: 20_000 }, dependsOn: ['r3'], sourceKind: 'heuristic' }] };
  const a = estimatePlanTime(scenario, () => performance({ firstTextMs: 3_000, visibleTps: 100 }), { config: exact });
  const b = estimatePlanTime(scenario, () => performance({ firstTextMs: 15_000, visibleTps: 25 }), { config: exact });
  assert.deepEqual(a.remainingMs, { low: 52_000, high: 52_000 }); assert.deepEqual(b.remainingMs, { low: 160_000, high: 160_000 });
});
test('T02 same-mode total duration EWMA 120s plus observed180s at alpha.2 is132s', () => {
  const profile = createProfile(route, prior({ totalCallMs: 120_000 }));
  const updated = updateProfile(profile, observation({ firstContentAtMs: null, firstTextAtMs: null, lastContentAtMs: null, endedAtMs: 180_000, visibleTextTokens: null }));
  assert.equal(updated.profile.totalCallMs, 132_000); assert.equal(profile.totalCallSamples, 0);
});
test('T03 aggregate speed is 1000 Tokens /4s =250 tok/s', () => {
  let profile = createProfile(route, prior());
  profile = updateProfile(profile, observation({ visibleTextTokens: 100, firstTextAtMs: 2_000, lastContentAtMs: 3_000, endedAtMs: 3_000 })).profile;
  profile = updateProfile(profile, observation({ attemptId: 'b', startedAtMs: 10_000, firstContentAtMs: 11_000, firstTextAtMs: 12_000, lastContentAtMs: 15_000, endedAtMs: 15_000, visibleTextTokens: 900 })).profile;
  assert.deepEqual(overallVisibleTps([profile]), { tokens: 1_000, seconds: 4, tps: 250, samples: 2 });
});
test('T04 text stage does not add the complete 20s already spent waiting', () => {
  const result = estimateRequestTime(request(), performance(), { phase: 'text', elapsedMs: 20_000, generatedTextTokens: 100 }, exact);
  assert.deepEqual(result.remainingMs, { low: 4_000, high: 4_000 }); assert.ok(result.reasons.includes('text-stage-no-repeat-wait'));
});
test('T05 TTFT differs from first body; only300 body Tokens enter speed', () => {
  const updated = updateProfile(createProfile(route, prior()), observation(), { performanceAlpha: 1 });
  assert.equal(updated.profile.firstContentMs, 1_000); assert.equal(updated.profile.firstTextMs, 20_000);
  assert.equal(updated.profile.realVisibleTokens, 300); assert.equal(updated.profile.realVisibleSeconds, 3);
  assert.equal(selectPerformance(route, [updated.profile], [], 23_000).visibleTps, 100);
});
test('T06 buffered release skips speed but retains end-to-end call duration', () => {
  const result = updateProfile(createProfile(route), observation({ buffered: true, firstTextAtMs: 99_800, lastContentAtMs: 100_000, endedAtMs: 100_000 }));
  assert.equal(result.accepted, true); assert.equal(result.speedAccepted, false); assert.equal(result.profile.totalCallSamples, 1);
  assert.equal(result.profile.speedSamples, 0); assert.ok(result.reasons.includes('buffered-release'));
});
test('speed exclusion is metric-specific for non-streaming, tool-only and hidden reasoning', () => {
  for (const flags of [{ streaming: false }, { toolOnly: true }, { hiddenReasoningSeparable: false }, { visibleTextTokens: null }]) {
    const result = updateProfile(createProfile(route), observation(flags));
    assert.equal(result.accepted, true); assert.equal(result.speedAccepted, false); assert.equal(result.profile.totalCallSamples, 1);
  }
});
test('T07 parallel10s/20s tools take20s wall while representing30s tool work', () => {
  const result = schedule([{ id: 'a', durationMs: { low: 10_000, high: 10_000 }, dependsOn: [] }, { id: 'b', durationMs: { low: 20_000, high: 20_000 }, dependsOn: [] }]);
  assert.equal(result.makespanMs.high, 20_000); assert.equal(result.totalWorkMs.high, 30_000);
});
test('T08 concurrency limits schedule batches instead of taking the largest single duration', () => {
  const units = [10_000, 20_000, 30_000].map((duration, index) => ({ id: String(index), durationMs: { low: duration, high: duration }, dependsOn: [], resource: 'tool' }));
  assert.equal(schedule(units, { maxConcurrency: 2 }).makespanMs.high, 40_000);
  assert.equal(schedule(units, { resourceLimits: { tool: 1 } }).makespanMs.high, 60_000);
});
test('dependency scheduling can execute independent models and tools together', () => {
  const result = schedule([{ id: 'start', durationMs: { low: 0, high: 0 }, dependsOn: [] }, { id: 'a', durationMs: { low: 10, high: 20 }, dependsOn: ['start'] }, { id: 'b', durationMs: { low: 20, high: 30 }, dependsOn: ['start'] }, { id: 'end', durationMs: { low: 1, high: 1 }, dependsOn: ['a', 'b'] }]);
  assert.deepEqual(result.makespanMs, { low: 21, high: 31 });
});
test('T09 internal retry duration is already in observed elapsed time', () => {
  const result = updateProfile(createProfile(route), observation({ endedAtMs: 30_000, includedInternalRetryMs: 10_000 }), { performanceAlpha: 1 });
  assert.equal(result.profile.totalCallMs, 30_000);
});
test('T10 five-minute human pause is excluded from active elapsed and performance learning', () => {
  const elapsed = calculateElapsed({ startedAtMs: 0, nowMs: 360_000, pauses: [{ startMs: 30_000, endMs: 330_000 }] });
  assert.deepEqual(elapsed, { elapsedWallMs: 360_000, elapsedActiveMs: 60_000, elapsedPausedMs: 300_000 });
  const result = updateProfile(createProfile(route), observation({ userPausedMs: 300_000, endedAtMs: 360_000 }));
  assert.equal(result.accepted, false); assert.equal(result.profile.totalCallSamples, 0);
});
test('overlapping human pauses are unioned and clamped to task interval', () => {
  assert.equal(calculateElapsed({ startedAtMs: 100, nowMs: 1_000, pauses: [{ startMs: 0, endMs: 200 }, { startMs: 150, endMs: 300 }, { startMs: 900, endMs: null }] }).elapsedPausedMs, 300);
});
test('T11 exhausted output budget returns unknown remaining while still running', () => {
  const result = estimateRequestTime(request(), performance(), { phase: 'text', elapsedMs: 50_000, generatedTextTokens: 300 }, exact);
  assert.equal(result.remainingMs, null); assert.ok(result.reasons.includes('output-budget-exhausted-task-still-running'));
});
test('T12 text continuing after analysis is still an unfinished text-stage estimate', () => {
  const result = estimateRequestTime(request(), performance(), { phase: 'text', elapsedMs: 50_000, generatedTextTokens: 50 }, exact);
  assert.deepEqual(result.remainingMs, { low: 5_000, high: 5_000 });
});
test('waiting beyond reference bound returns null instead of an eternal zero countdown', () => {
  const result = estimateRequestTime(request(), performance(), { phase: 'waiting', elapsedMs: 60_000 });
  assert.equal(result.remainingMs, null); assert.ok(result.reasons.includes('reference-range-exhausted-reassessing'));
});
test('conditional remaining waits require enough surviving samples', () => {
  const p = performance({ firstTextWaitSamplesMs: [10_000, 20_000, 30_000, 40_000, 50_000, 60_000] });
  const result = estimateRequestTime(request({ visibleTextTokens: { low: 50, high: 50 } }), p, { phase: 'waiting', elapsedMs: 15_000 }, exact);
  assert.deepEqual(result.remainingMs, { low: 6_000, high: 46_000 });
});
test('tool/unknown modes use total-call fallback even when visible output Tokens are known', () => {
  const result = estimateRequestTime(request({ route: { ...route, requestMode: 'mixed' } }), performance(), { phase: 'call', elapsedMs: 10_000 }, exact);
  assert.deepEqual(result.remainingMs, { low: 20_000, high: 20_000 });
});
test('R01 unsuccessful or interrupted calls retain diagnostics without training normal performance', () => {
  for (const outcome of ['failed', 'cancelled', 'timeout', 'truncated', 'interrupted'] as const) {
    const result = updateProfile(createProfile(route), observation({ outcome }));
    assert.equal(result.accepted, false); assert.equal(result.profile.totalCallSamples, 0); assert.equal(result.profile.failedCalls, 1);
  }
  const gap = updateProfile(createProfile(route), observation({ processGapMs: 10_000 }));
  assert.equal(gap.accepted, false);
});
test('R02 applying the same canonical attempt twice is idempotent and deterministic', () => {
  const seed = createProfile(route);
  const first = updateProfile(seed, observation());
  const duplicate = updateProfile(first.profile, observation());
  assert.equal(duplicate.accepted, false); assert.equal(duplicate.profile.totalCallSamples, 1);
  assert.deepEqual(updateProfile(seed, observation()).profile, first.profile);
});
test('R03 same-named model from another supplier never inherits local measured data', () => {
  const learned = updateProfile(createProfile(route), observation()).profile;
  const changed = { ...route, providerId: 'provider-b' };
  const selected = selectPerformance(changed, [learned], [], 23_000);
  assert.equal(selected.sourceKind, 'heuristic'); assert.equal(selected.samples, 0);
  assert.throws(() => updateProfile(learned, observation({ route: changed })));
  const sameProviderOtherEndpoint = selectPerformance({ ...route, endpointFingerprint: 'other' }, [learned], [], 23_000);
  assert.equal(sameProviderOtherEndpoint.match, 'same-provider-model'); assert.equal(sameProviderOtherEndpoint.trust, 'reference');
});
test('R03 slower recent calls shift local wait through EWMA', () => {
  const initial = updateProfile(createProfile(route, prior()), observation()).profile;
  const slower = updateProfile(initial, observation({ attemptId: 'b', firstTextAtMs: 40_000, lastContentAtMs: 43_000, endedAtMs: 43_000 })).profile;
  assert.equal(slower.firstTextMs, 24_000);
});
test('stale profiles are retained but replaced with available public/engineering priors', () => {
  const learned = updateProfile(createProfile(route), observation()).profile;
  const now = 23_000 + 8 * 86_400_000;
  const publicPrior = prior({ id: 'public-test', sourceKind: 'public-measured', firstTextMs: 5_000, appliesTo: { modelId: route.modelId, providerId: route.providerId, endpointFingerprint: route.endpointFingerprint } });
  const selected = selectPerformance(route, [learned], [publicPrior], now);
  assert.equal(selected.match, 'public-prior'); assert.equal(selected.firstTextMs, 5_000); assert.ok(selected.reasons.includes('stale-profile-retained-for-audit'));
  assert.equal(learned.totalCallSamples, 1);
});
test('unknown reasoning and mixed routing never display the observed trust label', () => {
  const unknown = { ...route, reasoningEffort: 'unknown', mixedRoute: true };
  const profile = updateProfile(createProfile(unknown), observation({ route: unknown })).profile;
  const selected = selectPerformance(unknown, [profile], [], 23_000);
  assert.equal(selected.trust, 'reference'); assert.ok(selected.reasons.includes('reasoning-mode-unknown')); assert.ok(selected.reasons.includes('mixed-route-upstream-unknown'));
});
test('fingerprints strip credentials/query/fragment, bucket keys separate tier/mode/effort', () => {
  const a = endpointFingerprint('https://user:secret@EXAMPLE.com/v1/?api_key=secret#private');
  const b = endpointFingerprint('https://example.com/v1');
  assert.equal(a, b); assert.doesNotMatch(a, /secret|user|example/);
  assert.notEqual(profileKey(route), profileKey({ ...route, serviceTier: 'priority' }));
  assert.notEqual(profileKey(route), profileKey({ ...route, requestMode: 'tool' }));
});
test('schedule validation rejects cycles, missing ids, negative ranges and zero limits', () => {
  assert.throws(() => schedule([{ id: 'a', durationMs: { low: 0, high: 1 }, dependsOn: ['b'] }, { id: 'b', durationMs: { low: 0, high: 1 }, dependsOn: ['a'] }]));
  assert.throws(() => schedule([{ id: 'a', durationMs: { low: -1, high: 1 }, dependsOn: [] }]));
  assert.throws(() => schedule([], { maxConcurrency: 0 }));
});
