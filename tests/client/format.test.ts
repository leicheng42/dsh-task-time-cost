import assert from 'node:assert/strict';
import test from 'node:test';
import { costSummary, costUnconfigured, formatDecimal, formatDuration, formatDurationRange, formatEta, formatLatency, formatMoneyList, formatMoneyRanges, formatNumber, formatProfileMetrics, formatState, formatTokenRange, localTiming, remainingSummary } from '../../src/client/format.ts';
import { en, zh } from '../../src/client/locale.ts';
import type { ProfileSummary } from '../../src/shared/wire.ts';
import { parseConfiguration } from '../../src/client/config.ts';
import { snapshot, translator } from './fixtures.ts';
const t = translator();

test('duration distinguishes zero, unknown, subsecond latency, and ordered ranges', () => {
  assert.equal(formatDuration(0, t), '0s');
  assert.equal(formatDuration(null, t), 'Unknown');
  assert.equal(formatDuration(Number.NaN, t), 'Unknown');
  assert.equal(formatDuration(-1, t), 'Unknown');
  assert.equal(formatDuration(61_999, t), '1m 1s');
  assert.equal(formatDuration(3_661_000, t), '1h 1m');
  assert.equal(formatDurationRange({ low: 60_000, high: 120_000 }, t), '1m–2m', 'a whole minute never prints a zero-second remainder');
  assert.equal(formatDurationRange({ low: 200, high: 100 }, t), 'Unknown');
  assert.equal(formatLatency(250, 'en', t), '250ms');
  assert.equal(formatLatency(1_230, 'en', t), '1.23s');
});

test('decimal cost formatting preserves tiny prices and integers above 2^53', () => {
  assert.equal(formatDecimal('0.000000000000000001', 'en'), '0.000000000000000001');
  assert.equal(formatDecimal('9007199254740993.12000', 'en'), '9,007,199,254,740,993.12');
  assert.equal(formatDecimal('0.00000', 'en'), '0');
  assert.equal(formatDecimal('1e-8', 'en'), null);
  assert.equal(formatDecimal('-1', 'en'), null);
  assert.equal(formatDecimal('NaN', 'en'), null);
});

test('different currencies stay separate and absent values remain unknown', () => {
  assert.equal(formatMoneyList([{ currency: 'USD', amount: '1.2' }, { currency: 'CNY', amount: '3.4' }], 'en', t), 'USD 1.2 · CNY 3.4');
  assert.equal(formatMoneyRanges([{ currency: 'USD', range: { low: '0', high: '0.002' } }], 'en', t), 'USD 0–0.002');
  assert.equal(formatMoneyList([], 'en', t), 'Unknown');
  assert.equal(formatMoneyRanges(null, 'en', t), 'Unknown');
  assert.equal(formatMoneyRanges([{ currency: 'USD', range: { low: 'unknown', high: '1' } }], 'en', t), 'Unknown');
});

test('observed fees remain visible independently of an incomplete future forecast', () => {
  assert.equal(costSummary(snapshot(), 'en', t), 'Partial: USD 0.01');
  for (const forecastCostStatus of ['partial', 'unavailable'] as const) {
    assert.equal(costSummary(snapshot({ forecastCostStatus }), 'en', t), 'Partial: USD 0.01');
  }
  assert.equal(costSummary(snapshot({ state: 'completed', observedCostStatus: 'partial' }), 'en', t), 'Partial: USD 0.01');
  assert.equal(costSummary(snapshot({ state: 'completed', observedCostStatus: 'complete' }), 'en', t), 'USD 0.01');
  assert.equal(costSummary(snapshot({ observedCostStatus: 'free', knownCost: [] }), 'en', t), 'Free');
  assert.equal(costSummary(snapshot({ forecastCostStatus: 'reference', estimatedTotalCost: null, knownCost: [] }), 'en', t), 'Unknown');
});

test('an unpriced task reads as unconfigured prices, not as a failed calculation', () => {
  // No price entry exists for any observed or forecast call: this is the real
  // state of a fresh install, so the panel must offer the configuration hint.
  assert.equal(costUnconfigured(snapshot({ knownCost: [], estimatedTotalCost: null })), true);
  assert.equal(costUnconfigured(snapshot({ knownCost: [], estimatedTotalCost: [] })), true);
  // One priced side is enough to be a genuine partial estimate, not "unset".
  assert.equal(costUnconfigured(snapshot({ knownCost: [], estimatedTotalCost: [{ currency: 'USD', range: { low: '0.02', high: '0.05' } }] })), false);
  assert.equal(costUnconfigured(snapshot()), false);
  // A task the provider served for free is priced at zero, not unconfigured.
  assert.equal(costUnconfigured(snapshot({ knownCost: [], estimatedTotalCost: null, forecastCostStatus: 'free' })), false);
});

test('local timer advances work only while running; waiting and terminal states freeze it', () => {
  assert.deepEqual(localTiming(snapshot(), 10_000, 12_000), { activeMs: 3_000, pausedMs: 0, wallMs: 3_000, remaining: { low: 8_000, high: 18_000 } });
  assert.deepEqual(localTiming(snapshot({ state: 'waiting_user', elapsedPausedMs: 500 }), 10_000, 12_000), { activeMs: 1_000, pausedMs: 2_500, wallMs: 3_000, remaining: { low: 10_000, high: 20_000 } });
  assert.equal(localTiming(snapshot({ state: 'completed' }), 10_000, 999_999).activeMs, 1_000);
  assert.equal(localTiming(snapshot({ state: 'completed' }), 10_000, 999_999).wallMs, 1_000);
  assert.equal(localTiming(snapshot(), 12_000, 10_000).activeMs, 1_000);
  assert.equal(remainingSummary(snapshot(), 0, 25_000, t), 'Estimate is being revised');
  assert.equal(remainingSummary(snapshot({ remainingMs: null }), 0, 1_000, t), 'Remaining time unknown');
});

test('number and token formatting preserve null separately from zero', () => {
  assert.equal(formatNumber(null, 'en', t), 'Unknown');
  assert.equal(formatNumber(0, 'en', t), '0');
  assert.equal(formatTokenRange({ low: 1_000, high: 2_000 }, 'en', t), '1,000–2,000 tokens');
  assert.equal(formatTokenRange(null, 'en', t), 'Unknown');
});

test('both locale dictionaries cover every UI key and interpolate in the selected language', () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  const z = translator(zh);
  assert.equal(formatDuration(61_000, z), '1m 1s');
  assert.equal(formatState('waiting_user', z), '等待用户');
  assert.equal(costSummary(snapshot({ forecastCostStatus: 'partial' }), 'zh', z), '已知部分：USD 0.01');
});

test('durations use latin unit letters in both locales and drop seconds once past ten minutes', () => {
  const z = translator(zh);
  assert.equal(formatDuration(9_000, z), '9s');
  assert.equal(formatDuration(125_000, z), '2m 5s');
  assert.equal(formatDuration(10 * 60_000, z), '10m', 'a long ETA must not imply second-level precision');
  assert.equal(formatDuration(3 * 3_600_000 + 25 * 60_000, z), '3h 25m');
  assert.equal(formatDuration(11 * 3_600_000, z), '11h');
  assert.equal(formatDuration(61_000, t), '1m 1s');
});

test('ETA bounds are rounded to a coarse step so the chip keeps a stable width', () => {
  const z = translator(zh);
  assert.equal(formatEta({ low: 9_000, high: 69_000 }, z), '≤2m', 'a tiny lower bound must not be rounded up into a false minimum');
  assert.equal(formatEta({ low: 40_000, high: 40_000 }, z), '30s–45s');
  assert.equal(formatEta({ low: 8 * 60_000 + 30_000, high: 30 * 60_000 }, z), '8m–30m', 'the requested compact form never mixes minute bounds with stray seconds');
  assert.equal(formatEta({ low: 0, high: 0 }, z), '0s');
  assert.equal(formatEta({ low: 600_000, high: 900_000 }, z), '10m–15m');
  assert.equal(formatEta({ low: 100, high: 50 }, z), '未知', 'an invalid span is unknown, never a guess');
  assert.equal(formatEta(null, z), '未知');
});

test('advanced configuration accepts an object and rejects arrays and primitives', () => {
  assert.deepEqual(parseConfiguration('{"performanceAlpha":0.2,"toolResultTokensPerCall":{"low":0,"high":2000}}'), { performanceAlpha: 0.2, toolResultTokensPerCall: { low: 0, high: 2000 } });
  for (const text of ['[]', 'null', '5', '"text"']) assert.throws(() => parseConfiguration(text), /CONFIG_OBJECT_REQUIRED/);
  assert.throws(() => parseConfiguration('{broken'), SyntaxError);
});

test('profile rows separate measured values from reference priors', () => {
  const base: ProfileSummary = { key: 'review', providerId: 'review-provider', modelId: 'review-model', endpointFingerprint: 'review-endpoint',
    requestMode: 'text', reasoningEffort: 'normal', serviceTier: 'standard', firstContentMs: 900, firstTextMs: 1_500,
    visibleTps: null, priorVisibleTps: 50, totalCallMs: 40_000, totalCallSamples: 0, firstTextSamples: 0, speedSamples: 0,
    failedCalls: 0, testedAt: null, sourceKind: 'heuristic' };
  const prior = formatProfileMetrics(base, 'en', t);
  assert.equal(prior.latency, 'reference 1.5s', 'A prior latency without local samples must not look measured');
  assert.equal(prior.speed, 'reference 50 tokens/s');
  assert.equal(prior.samples, 'samples 0');
  assert.equal(prior.measured, 'not measured yet');
  assert.equal(prior.source, 'Source: Heuristic assumptions', 'The row names the prior behind reference values');
  const measured = formatProfileMetrics({ ...base, visibleTps: 42.5, totalCallSamples: 3, firstTextSamples: 3, speedSamples: 2,
    testedAt: Date.UTC(2026, 10, 12, 12, 31) }, 'en', t);
  assert.equal(measured.latency, '1.5s', 'Locally backed values are printed plainly');
  assert.equal(measured.speed, '42.5 tokens/s');
  assert.equal(measured.samples, 'samples 3');
  assert.match(measured.measured, /^last .+/);
  const unknown = formatProfileMetrics({ ...base, firstTextMs: null, priorVisibleTps: null }, 'zh', translator(zh));
  assert.equal(unknown.latency, '未知', 'A missing latency is unknown, never zero');
  assert.equal(unknown.speed, '未知');
});
