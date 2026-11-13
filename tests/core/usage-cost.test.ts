import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUsage, resolvePrice, estimateCallCost, aggregateCosts, aggregateForecastCosts, validatePrices, roundMoney, upsertCallRecord, appendValuation, estimateBudgetUsage, estimateRequestCostRange, sumKnown, subtotalKnown } from '../../src/shared/index.ts';
import type { RawUsage, PriceEntry, CallLedger, CallRecord, RequestBudget } from '../../src/shared/index.ts';

const identity = { providerId: 'provider-a', endpointFingerprint: 'endpoint-a', requestedModelId: 'model-a' };
function usage(raw: RawUsage = {}) { return normalizeUsage({ inputTokens: 1_000, cacheReadTokens: 8_000, cacheWrite5mTokens: 800, cacheWrite1hTokens: 200, outputTokens: 500, reasoningTokens: 200, ...raw }, { schema: 'dsh', outputIncludesReasoning: true }); }
function price(overrides: Partial<PriceEntry> = {}): PriceEntry { return { id: 'synthetic-price', providerId: 'provider-a', modelId: 'model-a', priority: 'provider-catalog', currency: 'USD', unit: 'per-million-tokens', prices: { inputTokens: '2', cacheReadTokens: '0.2', cacheWrite5mTokens: '2.5', cacheWrite1hTokens: '4', outputTokens: '8' }, sourceKind: 'heuristic', sourceUrl: null, version: 'synthetic-v1', effectiveFrom: '2026-01-01', ...overrides }; }
function cost(raw: RawUsage = {}, entry = price()) { return estimateCallCost(usage(raw), resolvePrice(identity, [entry], [], '2026-11-12')); }

test('C01 fixed-point cost is exactly $0.0104 and JSON-safe', () => {
  const result = cost();
  assert.equal(result.status, 'complete'); assert.equal(result.amount, '0.0104');
  assert.equal(result.priceVersion, 'synthetic-v1');
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(roundMoney('0.0156', 3), '0.016');
});
test('C02 a whole-call multiplier is applied exactly once', () => {
  const result = cost({}, price({ multiplier: '1.5' }));
  assert.equal(result.amount, '0.0156');
});
test('C03 strict prompt threshold is applied per call, never after aggregation', () => {
  const entry = price({ rules: [{ id: 'long-context', when: { promptTokensAbove: 10_000 }, prices: { inputTokens: '4', outputTokens: '16' } }] });
  assert.equal(cost({}, entry).amount, '0.0104');
  assert.equal(cost({ inputTokens: 1_001 }, entry).amount, '0.016404');
  const small = cost({ inputTokens: 6_000, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 0, reasoningTokens: 0 }, entry);
  assert.equal(aggregateCosts([small, small]).knownCost[0].amount, '0.024');
});
test('explicit excess-only pricing consumes the declared input order', () => {
  const entry = price({ rules: [{ id: 'excess', when: { promptTokensAbove: 10_000 }, mode: 'excess-only', allocationOrder: ['cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'cacheWriteUnknownTokens', 'inputTokens'], prices: { inputTokens: '4' } }] });
  assert.equal(cost({ inputTokens: 1_001 }, entry).amount, '0.010404');
});
test('T05 reasoning included in output is charged once; 500 total, 300 body', () => {
  const normalized = usage();
  assert.equal(normalized.outputTokens, 500); assert.equal(normalized.visibleOutputTokens, 300);
  assert.equal(cost().amount, '0.0104');
});
test('DSH input excludes cache; inclusive-input importer subtracts cache exactly once', () => {
  const dsh = usage();
  const inclusive = normalizeUsage({ inputTokens: 10_000, cacheReadTokens: 8_000, cacheWrite5mTokens: 800, cacheWrite1hTokens: 200, outputTokens: 500 }, { schema: 'inclusive-input', outputIncludesReasoning: true });
  assert.equal(dsh.inputTokens, 1_000); assert.equal(inclusive.inputTokens, 1_000);
  assert.equal(inclusive.totalTokens, 10_500);
});
test('missing optional usage fields remain unknown unless source semantics authorize zero', () => {
  const missing = normalizeUsage({ inputTokens: 1_000, outputTokens: 500 }, { schema: 'dsh', outputIncludesReasoning: true });
  assert.equal(missing.cacheReadTokens, null); assert.equal(missing.status, 'partial');
  const explicit = normalizeUsage({ inputTokens: 1_000, outputTokens: 500 }, { schema: 'dsh', outputIncludesReasoning: true, missingMeansZero: ['cacheReadTokens', 'cacheWriteTokens'] });
  assert.equal(explicit.status, 'complete');
  assert.equal(explicit.cacheWrite1hTokens, 0);
});
test('a request that reported no usage does not erase the requests that did', () => {
  // Exact arithmetic and observed subtotal answer different questions: one
  // request without adapter numbers made `sumKnown` null for a 420-call task,
  // which hid 43 M observed tokens behind "Unknown".
  assert.equal(sumKnown([10, null, 30]), null);
  assert.equal(subtotalKnown([10, null, 30]), 40);
  assert.equal(subtotalKnown([null, null]), null, 'no observation at all is not zero');
  assert.equal(subtotalKnown([]), null, 'an empty list has no observed subtotal');
});
test('cache aggregate includes 1h; unknown TTL is not assigned the cheapest price', () => {
  const raw = { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 1_000, cacheWrite1hTokens: 200, outputTokens: 0 };
  const known = normalizeUsage(raw, { schema: 'dsh', outputIncludesReasoning: true, defaultCacheWriteTtl: '5m' });
  assert.equal(known.cacheWrite5mTokens, 800); assert.equal(known.cacheWrite1hTokens, 200); assert.equal(known.promptTokens, 1_100);
  const unknown = normalizeUsage(raw, { schema: 'dsh', outputIncludesReasoning: true });
  assert.equal(unknown.cacheWriteUnknownTokens, 800);
  const priced = estimateCallCost(unknown, resolvePrice(identity, [price()]));
  assert.equal(priced.amount, null); assert.ok(priced.unpricedItems.includes('cacheWriteUnknownTokens:price'));
});
test('output excluding reasoning requires known reasoning; unknown is not zero', () => {
  const normalized = normalizeUsage({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 300, reasoningTokens: 200 }, { schema: 'dsh', outputIncludesReasoning: false });
  assert.equal(normalized.outputTokens, 500);
  const missing = normalizeUsage({ outputTokens: 300 }, { schema: 'dsh', outputIncludesReasoning: false });
  assert.equal(missing.outputTokens, null);
});
test('negative, nonintegral and conflicting totals invalidate exact pricing', () => {
  for (const raw of [{ inputTokens: -1 }, { outputTokens: 1.5 }, { totalTokens: 5 }, { reasoningTokens: 501 }]) {
    const normalized = usage(raw);
    assert.equal(normalized.exact, false);
    assert.equal(estimateCallCost(normalized, resolvePrice(identity, [price()])).amount, null);
  }
});
test('C04 missing price remains unpriced while an explicit free model is free', () => {
  const absent = estimateCallCost(usage(), resolvePrice({ ...identity, requestedModelId: 'missing' }, [price()]));
  const free = cost({}, price({ explicitFree: true, prices: {} }));
  assert.equal(absent.status, 'unpriced'); assert.equal(absent.knownAmount, null); assert.equal(free.status, 'free'); assert.equal(free.amount, '0');
  const sum = aggregateCosts([absent, free]);
  assert.equal(sum.status, 'partial'); assert.equal(sum.totalCost, null); assert.equal(sum.unpricedCalls, 1);
});
test('price priority is endpoint override, provider wildcard, catalog, public, explicit Same as', () => {
  const catalog = price();
  const wildcard = price({ id: 'wild', modelId: 'model-*', priority: 'provider-wildcard' });
  const exact = price({ id: 'exact', endpointFingerprint: 'endpoint-a', priority: 'user-exact' });
  assert.equal(resolvePrice(identity, [catalog, wildcard, exact]).entry!.id, 'exact');
  assert.equal(resolvePrice({ ...identity, endpointFingerprint: 'endpoint-b' }, [catalog, wildcard, exact]).entry!.id, 'wild');
  assert.equal(resolvePrice({ ...identity, requestedModelId: 'model-a-similar' }, [catalog]).match, 'unpriced');
  const alias = [{ providerId: 'other', modelId: 'alias', targetProviderId: 'provider-a', targetModelId: 'model-a' }];
  assert.equal(resolvePrice({ providerId: 'other', requestedModelId: 'alias' }, [catalog], alias).match, 'same-as');
});
test('served model identity takes priority; unknown billing identity blocks pricing', () => {
  const real = price({ modelId: 'served-real' });
  assert.equal(resolvePrice({ ...identity, servedModelId: 'served-real' }, [real]).entry!.id, real.id);
  assert.equal(resolvePrice({ ...identity, billingIdentityConfirmed: false }, [price()]).entry, null);
});
test('service tier and UTC-window multipliers apply per request, including overnight windows', () => {
  const entry = price({ rules: [{ id: 'priority', when: { serviceTier: 'priority' }, multiplier: '1.5' }, { id: 'night', when: { utcHours: { start: 22, end: 6 } }, multiplier: '0.5' }] });
  const resolution = resolvePrice(identity, [entry]);
  const result = estimateCallCost(usage(), resolution, { serviceTier: 'priority', at: '2026-11-12T23:00:00Z' });
  assert.equal(result.amount, '0.0078'); assert.deepEqual(result.appliedRuleIds, ['priority', 'night']);
  const unknown = estimateCallCost(usage(), resolution);
  assert.equal(unknown.amount, null); assert.equal(unknown.knownAmount, null);
});
test('different currencies stay in separate groups', () => {
  const sum = aggregateCosts([cost(), cost({}, price({ currency: 'CNY' }))]);
  assert.deepEqual(sum.knownCost, [{ currency: 'CNY', amount: '0.0104' }, { currency: 'USD', amount: '0.0104' }]);
});
test('forecast completeness is separate from observed completeness', () => {
  const observed = aggregateCosts([cost()]);
  const missing = estimateCallCost(usage(), resolvePrice({ ...identity, requestedModelId: 'absent' }, []));
  const forecast = aggregateForecastCosts(observed, [{ low: missing, high: missing }]);
  assert.equal(observed.status, 'complete'); assert.equal(forecast.status, 'unavailable'); assert.equal(forecast.totalCost, null);
  const full = aggregateForecastCosts(observed, [{ low: cost(), high: cost({}, price({ multiplier: '1.5' })) }]);
  assert.deepEqual(full.totalCost, [{ currency: 'USD', range: { low: '0.0208', high: '0.026' } }]);
});
test('C05 live, settlement, external and replay snapshots count one canonical attempt', () => {
  let ledger: CallLedger = { records: {} };
  const initial: CallRecord = { attemptId: 'a', source: 'dsh', stage: 'live', revision: 1, usage: usage({ outputTokens: 250 }), valuations: [] };
  ledger = upsertCallRecord(ledger, initial).ledger;
  ledger = upsertCallRecord(ledger, { ...initial, source: 'external', revision: 100 }).ledger;
  ledger = upsertCallRecord(ledger, { ...initial, stage: 'durable', revision: 2, usage: usage() }).ledger;
  ledger = upsertCallRecord(ledger, { ...initial, stage: 'durable', revision: 2, usage: usage() }).ledger;
  ledger = upsertCallRecord(ledger, { ...initial, revision: 9 }).ledger;
  assert.equal(Object.keys(ledger.records).length, 1); assert.equal(ledger.records.a.usage.outputTokens, 500);
  assert.equal(aggregateCosts(Object.values(ledger.records).map(record => estimateCallCost(record.usage, resolvePrice(identity, [price()])))).knownCost[0].amount, '0.0104');
});
test('C06 current prices do not mutate prior resolved or stored price versions', () => {
  const entries = [price()];
  const resolved = resolvePrice(identity, entries);
  entries[0].prices.outputTokens = '80'; entries[0].version = 'synthetic-v2';
  const original = estimateCallCost(usage(), resolved);
  const updated = estimateCallCost(usage(), resolvePrice(identity, entries));
  const record: CallRecord = { attemptId: 'a', source: 'dsh', stage: 'durable', revision: 1, usage: usage(), valuations: [{ estimateVersion: 'initial', cost: original }] };
  const revision = appendValuation(record, { estimateVersion: 'revalue-v2', cost: updated });
  assert.equal(original.amount, '0.0104'); assert.equal(revision.valuations[0].cost.priceVersion, 'synthetic-v1');
  assert.notEqual(revision.valuations[1].cost.amount, original.amount); assert.equal(record.valuations.length, 1);
  assert.throws(() => appendValuation(revision, { estimateVersion: 'initial', cost: updated }));
});
test('forecast unknown cache and hidden reasoning never become a zero-cost full estimate', () => {
  const request: RequestBudget = { id: 'r', route: { providerId: 'p', endpointFingerprint: 'e', modelId: 'm', requestMode: 'text', reasoningEffort: 'unknown', serviceTier: 'default' }, inputTokens: { low: 100, high: 100 }, visibleTextTokens: { low: 300, high: 300 }, visibleOutputTokens: { low: 300, high: 300 }, reasoningTokens: null, cacheReadRatio: null, dependsOn: [], sourceKind: 'heuristic' };
  const unknown = estimateBudgetUsage(request, 'low');
  assert.equal(unknown.usage.inputTokens, null); assert.equal(unknown.usage.outputTokens, null);
  const scenario = estimateBudgetUsage(request, 'low', { cacheReadRatio: { low: 0, high: 0 }, cacheWrite5mTokens: { low: 0, high: 0 }, cacheWrite1hTokens: { low: 0, high: 0 }, reasoningTokens: { low: 200, high: 200 } });
  assert.equal(scenario.usage.outputTokens, 500); assert.equal(scenario.usage.inputTokens, 100);
});
test('forecast cache corners are evaluated independently: larger cached input can cost less', () => {
  const request: RequestBudget = { id: 'r', route: { providerId: 'provider-a', endpointFingerprint: 'endpoint-a', modelId: 'model-a', requestMode: 'text', reasoningEffort: 'off', serviceTier: 'standard' }, inputTokens: { low: 100, high: 200 }, visibleTextTokens: { low: 0, high: 0 }, visibleOutputTokens: { low: 0, high: 0 }, reasoningTokens: { low: 0, high: 0 }, cacheReadRatio: { low: 0, high: 1 }, dependsOn: [], sourceKind: 'heuristic' };
  const result = estimateRequestCostRange(request, resolvePrice(identity, [price()]), { cacheWrite5mTokens: { low: 0, high: 0 }, cacheWrite1hTokens: { low: 0, high: 0 } });
  assert.equal(result.low.amount, '0.00002'); assert.equal(result.high.amount, '0.0004');
  assert.ok(result.scenarioCount >= 4);
});
test('forecast includes feasible interior cache boundary when writes exclude100% reads', () => {
  const request: RequestBudget = { id: 'r', route: { providerId: 'p', endpointFingerprint: 'e', modelId: 'm', requestMode: 'text', reasoningEffort: 'off', serviceTier: 'standard' }, inputTokens: { low: 100, high: 100 }, visibleTextTokens: { low: 0, high: 0 }, visibleOutputTokens: { low: 0, high: 0 }, reasoningTokens: { low: 0, high: 0 }, cacheReadRatio: { low: 0.5, high: 1 }, dependsOn: [], sourceKind: 'heuristic' };
  const result = estimateRequestCostRange(request, resolvePrice(identity, [price()]), { cacheWrite5mTokens: { low: 10, high: 10 }, cacheWrite1hTokens: { low: 0, high: 0 } });
  assert.equal(result.low.amount, '0.000043'); assert.equal(result.high.amount, '0.000115');
  assert.throws(() => estimateRequestCostRange(request, resolvePrice(identity, [price()]), { cacheReadRatio: { low: 1, high: 1 }, cacheWrite5mTokens: { low: 10, high: 10 }, cacheWrite1hTokens: { low: 0, high: 0 } }));
});
test('forecast checks interior context threshold when the tier is cheaper above it', () => {
  const request: RequestBudget = { id: 'r', route: { providerId: 'p', endpointFingerprint: 'e', modelId: 'm', requestMode: 'text', reasoningEffort: 'off', serviceTier: 'standard' }, inputTokens: { low: 100, high: 300 }, visibleTextTokens: { low: 0, high: 0 }, visibleOutputTokens: { low: 0, high: 0 }, reasoningTokens: { low: 0, high: 0 }, cacheReadRatio: { low: 0, high: 0 }, dependsOn: [], sourceKind: 'heuristic' };
  const entry = price({ rules: [{ id: 'discount-tier', when: { promptTokensAbove: 200 }, prices: { inputTokens: '0.1' } }] });
  const result = estimateRequestCostRange(request, resolvePrice(identity, [entry]), { cacheWrite5mTokens: { low: 0, high: 0 }, cacheWrite1hTokens: { low: 0, high: 0 } });
  assert.equal(result.low.amount, '0.0000201'); assert.equal(result.high.amount, '0.0004');
});
test('price validation rejects invalid decimals, duplicate rules, alias cycles, and free paid rates', () => {
  assert.throws(() => validatePrices([price({ prices: { inputTokens: '-1' } })]));
  assert.throws(() => validatePrices([price({ explicitFree: true })]));
  assert.throws(() => validatePrices([price({ rules: [{ id: 'x', when: {}, multiplier: '1' }, { id: 'x', when: {}, multiplier: '1' }] })]));
  assert.throws(() => validatePrices([], [{ providerId: 'a', modelId: 'm', targetProviderId: 'b', targetModelId: 'n' }, { providerId: 'b', modelId: 'n', targetProviderId: 'a', targetModelId: 'm' }]));
});
