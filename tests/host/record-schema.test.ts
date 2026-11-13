import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { callRecordSchema } from '../../src/host/record-schema.ts';
import type { CallRecord } from '../../src/host/repository.ts';
import { EstimatorEngine } from '../../src/host/engine.ts';
import { defaultPluginConfig, validatePluginConfig } from '../../src/host/config.ts';
import { RuntimeObservations } from '../../src/host/runtime.ts';
import type { LiveAttempt } from '../../src/host/runtime.ts';
import { normalizeUsage, INPUT_CATEGORIES } from '../../src/shared/usage.ts';
import type { RawUsage, UsageSemantics } from '../../src/shared/usage.ts';
import { resolvePrice, estimateCallCost } from '../../src/shared/pricing.ts';
import type { PriceEntry, SameAs } from '../../src/shared/pricing.ts';
import { storageFixture } from '../helpers/storage.ts';

const raw: RawUsage = { inputTokens: 1000, cacheReadTokens: 8000, cacheWriteTokens: 1000,
  cacheWrite1hTokens: 200, outputTokens: 500, reasoningTokens: 200 };
const semantics: UsageSemantics = { schema: 'dsh', outputIncludesReasoning: true, defaultCacheWriteTtl: '5m' };
function price(): PriceEntry {
  return { id: 'historical-price', providerId: 'schema-provider', endpointFingerprint: 'schema-endpoint', modelId: 'schema-model',
    priority: 'user-exact', currency: 'USD', unit: 'per-million-tokens',
    prices: { inputTokens: '2', cacheReadTokens: '0.2', cacheWrite5mTokens: '2.5', cacheWrite1hTokens: '4', cacheWriteUnknownTokens: null, outputTokens: '8' },
    multiplier: '1.5', sourceKind: 'heuristic', sourceUrl: null, version: 'historical-v1', effectiveFrom: '1970-01-01T00:00:00.000Z' };
}
function record(options: { raw?: RawUsage | null; semantics?: UsageSemantics; entry?: PriceEntry | null; aliases?: SameAs[] } = {}): CallRecord {
  const route = { providerId: 'schema-provider', endpointFingerprint: 'schema-endpoint', modelId: 'schema-model',
    requestMode: 'text' as const, reasoningEffort: 'normal', serviceTier: 'standard', inputBucket: 'small', cacheBucket: 'warm', concurrencyBucket: '1', mixedRoute: false };
  const source = options.raw === undefined ? raw : options.raw;
  const usage = normalizeUsage(source ?? {}, options.semantics ?? semantics);
  const resolution = resolvePrice({ providerId: route.providerId, requestedModelId: route.modelId, endpointFingerprint: route.endpointFingerprint },
    options.entry === null ? [] : [options.entry ?? price()], options.aliases ?? [], '1970-01-01T00:00:01.000Z');
  const fact: CallRecord['fact'] = { id: 'session:7', seq: 7, turn: 1, step: 1, startedAt: 1000.125, endedAt: 2000.75,
    firstContentAt: 1250.25, firstTextAt: 1500.5, lastContentAt: 1999.875,
    route: { providerId: route.providerId, modelId: route.modelId, reasoningEffort: route.reasoningEffort },
    mode: 'text', textChars: 1200, reasoningChars: 800, toolChars: 0, textDeltas: 3,
    usage: source, finish: 'stop', outcome: 'completed', timingSource: 'live-attempt' };
  return { id: 'session:7', savedAt: fact.endedAt, fact, route, usage, resolution,
    cost: estimateCallCost(usage, resolution, { at: '1970-01-01T00:00:01.000Z', serviceTier: 'standard' }),
    observation: { attemptId: 'session:attempt-1', route: { ...route }, startedAtMs: fact.startedAt, endedAtMs: fact.endedAt,
      firstContentAtMs: fact.firstContentAt, firstTextAtMs: fact.firstTextAt, lastContentAtMs: fact.lastContentAt,
      outcome: 'completed', streaming: true, buffered: false, hiddenReasoningSeparable: usage.visibleOutputTokens !== null,
      toolOnly: false, visibleTextTokens: usage.visibleOutputTokens, tokenMeasurement: 'reported', userPausedMs: 0.125,
      processGapMs: 0, includedInternalRetryMs: 0, timingSource: 'live-attempt-monotonic' } };
}

function alter(source: CallRecord, path: readonly (string | number)[], value: unknown): unknown {
  const copy: unknown = structuredClone(source);
  let cursor = copy as Record<string, unknown>;
  for (const key of path.slice(0, -1)) {
    const next = cursor[String(key)];
    assert.ok(next !== null && typeof next === 'object', `Missing fixture path: ${path.join('.')}`);
    cursor = next as Record<string, unknown>;
  }
  cursor[String(path.at(-1))] = value;
  return copy;
}
function reject(value: unknown, label: string) {
  let accepted: boolean | undefined;
  assert.doesNotThrow(() => { accepted = callRecordSchema.safeParse(value).success; }, `${label}: safeParse threw`);
  assert.equal(accepted, false, label);
}

async function actualEngine(t: TestContext) {
  const fixture = await storageFixture();
  let engine: EstimatorEngine | undefined;
  t.after(async () => { engine?.dispose(); await fixture.close(); });
  const repository = await fixture.open();
  assert.equal(repository.available, true, fixture.messages.join('\n'));
  const config = validatePluginConfig({ ...defaultPluginConfig(), prices: [price()], routeOverrides: {
    'schema-provider': { endpointFingerprint: 'schema-endpoint', serviceTier: 'standard', outputIncludesReasoning: true, cacheFieldsOmittedAreZero: true, cacheWriteTtl: '5m' },
  } });
  engine = new EstimatorEngine(config, repository, [], new RuntimeObservations({ wall: () => 1000.125, monotonic: () => 0.125 }));
  return { engine, repository, fixture };
}

test('schema admits the actual Engine durable and live records, including fractional monotonic timestamps', async t => {
  const { engine, repository, fixture } = await actualEngine(t);
  const source = record();
  const durable = engine.recordCall('session', { ...source.fact, timingSource: 'step-boundary' });
  assert.equal(durable.observation, null);
  assert.equal(durable.cost.amount, '0.0156');
  assert.deepEqual(callRecordSchema.parse(JSON.parse(JSON.stringify(durable))), durable);
  const live: LiveAttempt = { ...source.fact, id: 'attempt-2', sessionId: 'session', startedMono: 0.125, lastIndex: 2 };
  const measured = engine.recordCall('session', { ...source.fact, id: 'session:8', seq: 8 }, { attempt: live, endedAt: source.fact.endedAt });
  assert.equal(measured.observation?.firstTextAtMs, 1500.5);
  assert.equal(measured.observation?.visibleTextTokens, 300);
  assert.deepEqual(callRecordSchema.parse(JSON.parse(JSON.stringify(measured))), measured);
  await repository.flush();
  assert.equal(repository.error, null, fixture.messages.join('\n'));
});

test('schema preserves the original version, exact decimal amounts, reasoning and mutually exclusive cache counts', () => {
  const source = record();
  const parsed = callRecordSchema.parse(source);
  assert.deepEqual(parsed, source);
  assert.equal(parsed.cost.amount, '0.0156');
  assert.equal(parsed.cost.priceVersion, 'historical-v1');
  assert.equal(parsed.usage.outputTokens, 500);
  assert.equal(parsed.usage.visibleOutputTokens, 300);
  assert.equal(parsed.usage.cacheWrite5mTokens, 800);
  assert.equal(parsed.usage.cacheWrite1hTokens, 200);
  parsed.resolution.entry!.version = 'caller-edit';
  assert.equal(source.resolution.entry?.version, 'historical-v1', 'Parsed snapshots must not alias the original input');
});

test('unknown usage and an absent price remain null and unpriced, never free or zero', () => {
  const source = record({ raw: null, entry: null, semantics: { schema: 'dsh', outputIncludesReasoning: 'unknown' } });
  const parsed = callRecordSchema.parse(source);
  assert.equal(parsed.usage.status, 'unknown');
  assert.equal(parsed.usage.outputTokens, null);
  assert.equal(parsed.usage.cacheReadTokens, null);
  assert.equal(parsed.usage.totalTokens, null);
  assert.equal(parsed.cost.status, 'unpriced');
  assert.equal(parsed.cost.amount, null);
  assert.equal(parsed.cost.knownAmount, null);
  assert.equal(parsed.resolution.entry, null);
  assert.deepEqual(parsed, source);
});

test('unknown cache TTL keeps a partial historical knownAmount instead of discarding the valuation', () => {
  const source = record({ semantics: { schema: 'dsh', outputIncludesReasoning: true, defaultCacheWriteTtl: null } });
  assert.equal(source.cost.status, 'partial');
  assert.ok(source.cost.knownAmount !== null);
  const parsed = callRecordSchema.parse(source);
  assert.equal(parsed.usage.cacheWriteUnknownTokens, 800);
  assert.equal(parsed.cost.amount, null);
  assert.equal(parsed.cost.knownAmount, source.cost.knownAmount);
  assert.equal(parsed.cost.priceVersion, 'historical-v1');
});

test('an explicitly free entry is valid even when token usage is unknown', () => {
  const free = price(); free.multiplier = '1'; free.explicitFree = true;
  free.prices = { inputTokens: '0', cacheReadTokens: '0', cacheWrite5mTokens: '0', cacheWrite1hTokens: '0', cacheWriteUnknownTokens: '0', outputTokens: '0' };
  const source = record({ entry: free, raw: null });
  assert.equal(source.usage.status, 'unknown');
  assert.equal(source.cost.status, 'free');
  assert.deepEqual(callRecordSchema.parse(source), source);
});

test('explicit SameAs pricing may reference another supplier without changing the observed route', () => {
  const reference = price(); reference.providerId = 'reference-provider'; reference.modelId = 'reference-model'; delete reference.endpointFingerprint;
  const source = record({ entry: reference, aliases: [{ providerId: 'schema-provider', modelId: 'schema-model', targetProviderId: 'reference-provider', targetModelId: 'reference-model' }] });
  assert.equal(source.resolution.match, 'same-as');
  assert.equal(source.cost.amount, '0.0156');
  assert.deepEqual(callRecordSchema.parse(source), source);
});

test('the bounded legacy LiveAttempt whitelist is removed while old pricing and safe attempt ids survive', () => {
  const source = record();
  const legacy = { ...source, fact: { ...source.fact, id: 'old-live-attempt-id', startedMono: 0.125, lastIndex: -1, sessionId: 'session' } };
  const parsed = callRecordSchema.parse(legacy);
  assert.deepEqual(parsed, { ...source, fact: { ...source.fact, id: 'old-live-attempt-id' } });
  assert.equal(parsed.cost.knownAmount, '0.0156');
  assert.equal(parsed.cost.priceVersion, 'historical-v1');
  assert.equal(legacy.fact.startedMono, 0.125, 'Legacy input must not be mutated');
  for (const [key, value] of [['startedMono', Infinity], ['lastIndex', -2], ['sessionId', { prompt: 'private' }]] as const) {
    reject(alter(legacy, ['fact', key], value), `Invalid legacy ${key}`);
  }
});

test('SDK adapter finish reasons and excluded clock windows remain readable without pretending to be training samples', () => {
  const source = record();
  source.fact.finish = 'adapter-specific-safe-reason';
  source.fact.endedAt = 900; // A durable wall clock correction can invalidate timing but not the invoice.
  source.observation!.endedAtMs = 900;
  source.observation!.outcome = 'timeout';
  source.observation!.tokenMeasurement = 'tokenizer-approximate';
  assert.deepEqual(callRecordSchema.parse(source), source);
});

test('normalized diagnostics survive conflicts, and safe-integer aggregate overflow remains unknown', () => {
  const conflicted = record({ raw: { ...raw, totalTokens: 1 } });
  assert.equal(conflicted.usage.status, 'partial');
  assert.equal(conflicted.usage.totalTokens, null);
  assert.deepEqual(callRecordSchema.parse(conflicted), conflicted);
  const overflow = record({ raw: { inputTokens: Number.MAX_SAFE_INTEGER, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0 } });
  assert.equal(overflow.usage.promptTokens, null);
  assert.equal(overflow.usage.totalTokens, null);
  assert.deepEqual(callRecordSchema.parse(overflow), overflow);
});

test('all nested numeric counters reject negative, fractional, unsafe and nonfinite values', () => {
  const source = record();
  for (const path of [['fact', 'seq'], ['fact', 'turn'], ['fact', 'step'], ['fact', 'textChars'], ['fact', 'textDeltas'], ['fact', 'usage', 'inputTokens'], ['usage', 'outputTokens'], ['observation', 'visibleTextTokens']]) {
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '10']) reject(alter(source, path, value), `${path.join('.')}=${String(value)}`);
  }
  for (const path of [['savedAt'], ['fact', 'startedAt'], ['fact', 'firstTextAt'], ['observation', 'endedAtMs'], ['observation', 'userPausedMs']]) {
    for (const value of [-1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '100']) reject(alter(source, path, value), `${path.join('.')}=${String(value)}`);
  }
});

test('required unknown fields cannot be omitted and unknown booleans/enums are not coerced', () => {
  const source = record();
  for (const path of [['observation'], ['usage', 'outputTokens'], ['usage', 'diagnostics'], ['fact', 'usage'], ['resolution', 'entry']]) {
    reject(alter(source, path, undefined), `Missing ${path.join('.')}`);
  }
  for (const path of [['fact', 'outcome'], ['fact', 'mode'], ['fact', 'timingSource'], ['route', 'requestMode'], ['usage', 'status'], ['cost', 'status'], ['resolution', 'match'], ['resolution', 'entry', 'sourceKind'], ['resolution', 'entry', 'priority'], ['observation', 'outcome'], ['observation', 'tokenMeasurement']]) {
    reject(alter(source, path, 'invented'), `Invalid ${path.join('.')}`);
  }
  for (const path of [['route', 'mixedRoute'], ['usage', 'exact'], ['observation', 'streaming'], ['observation', 'hiddenReasoningSeparable']]) reject(alter(source, path, 'false'), `Invalid ${path.join('.')}`);
});

test('nested prices, tier allocation, UTC windows, dates and free declarations reuse core pricing validation', () => {
  const entry = price();
  entry.rules = [{ id: 'window', when: { serviceTier: 'priority', utcHours: { start: 23, end: 4 } }, mode: 'whole-request', prices: { outputTokens: '9' }, multiplier: '1.2' },
    { id: 'excess', when: { promptTokensAbove: 20_000 }, mode: 'excess-only', allocationOrder: [...INPUT_CATEGORIES], prices: { inputTokens: '3' } }];
  entry.effectiveUntil = '2100-01-01T00:00:00Z';
  const source = record({ entry });
  assert.deepEqual(callRecordSchema.parse(source), source);
  const changes: [readonly (string | number)[], unknown][] = [
    [['resolution', 'entry', 'currency'], 'usd'], [['resolution', 'entry', 'unit'], 'per-token'],
    [['resolution', 'entry', 'prices', 'inputTokens'], '0.0000000000001'],
    [['resolution', 'entry', 'multiplier'], '-1'], [['resolution', 'entry', 'explicitFree'], true],
    [['resolution', 'entry', 'effectiveFrom'], 'not-a-date'], [['resolution', 'entry', 'effectiveUntil'], '1960-01-01'],
    [['resolution', 'entry', 'rules', 0, 'when', 'utcHours', 'end'], 23],
    [['resolution', 'entry', 'rules', 0, 'when', 'utcHours', 'start'], 24],
    [['resolution', 'entry', 'rules', 1, 'when', 'promptTokensAbove'], 1.5],
    [['resolution', 'entry', 'rules', 1, 'allocationOrder'], ['inputTokens']],
    [['resolution', 'entry', 'rules', 1, 'allocationOrder'], Array(5).fill('inputTokens')],
    [['resolution', 'entry', 'rules', 1, 'prices', 'outputTokens'], '1'],
    [['resolution', 'entry', 'rules', 1, 'multiplier'], '1'],
  ];
  for (const [path, value] of changes) reject(alter(source, path, value), `Invalid ${path.join('.')}`);
});

test('historical money is a fixed decimal string and incomplete costs cannot claim a complete total', () => {
  const source = record();
  for (const value of [0.0156, '-1', '+1', '1e-3', 'NaN', 'Infinity', '.5', '1.', '0.0000000000000000000000001']) {
    reject(alter(source, ['cost', 'amount'], value), `Invalid amount ${String(value)}`);
    reject(alter(source, ['cost', 'knownAmount'], value), `Invalid known amount ${String(value)}`);
  }
  reject(alter(source, ['cost', 'priceVersion'], 'current-v2'), 'Do not silently substitute the current price version');
  reject(alter(source, ['cost', 'priceId'], 'another-price'), 'Mismatched price identity');
  reject(alter(source, ['cost', 'currency'], 'CNY'), 'Mismatched currency');
  reject(alter(source, ['cost', 'knownAmount'], '0'), 'Complete amount cannot disagree with known amount');
  reject(alter(source, ['cost', 'status'], 'partial'), 'Partial total must stay null');
  reject(alter(source, ['cost', 'status'], 'free'), 'A positive total is not free');
  const trailingZero = alter(source, ['resolution', 'entry', 'prices', 'inputTokens'], '2.0000000000000');
  assert.equal(callRecordSchema.safeParse(trailingZero).success, true, 'Keep parseFixed-compatible insignificant trailing zeros');
});

test('schema rejects raw content and arbitrary fields at every nested object boundary', () => {
  const entry = price();
  entry.rules = [{ id: 'window', when: { utcHours: { start: 1, end: 2 } }, prices: { outputTokens: '8' } }];
  const source = record({ entry });
  const privateValue = 'PRIVATE_CONTENT_SENTINEL';
  for (const path of [['prompt'], ['fact', 'text'], ['fact', 'arguments'], ['fact', 'route', 'apiKey'], ['fact', 'usage', 'raw'],
    ['route', 'messages'], ['usage', 'body'], ['cost', 'rawResponse'], ['resolution', 'content'], ['resolution', 'entry', 'prompt'],
    ['resolution', 'entry', 'prices', 'reasoningTokens'], ['resolution', 'entry', 'rules', 0, 'arguments'],
    ['resolution', 'entry', 'rules', 0, 'when', 'prompt'], ['resolution', 'entry', 'rules', 0, 'when', 'utcHours', 'text'],
    ['observation', 'body'], ['observation', 'route', 'credentials']]) {
    const result = callRecordSchema.safeParse(alter(source, path, privateValue));
    assert.equal(result.success, false, `${path.join('.')} must be rejected instead of stripped`);
    if (!result.success) assert.equal(result.error.message.includes(privateValue), false, 'Do not echo rejected content into diagnostics');
  }
});

test('route mismatches cannot train another supplier or mode from an otherwise valid stored record', () => {
  const source = record();
  for (const path of [['fact', 'route', 'providerId'], ['fact', 'route', 'modelId'], ['fact', 'route', 'reasoningEffort'],
    ['observation', 'route', 'providerId'], ['observation', 'route', 'endpointFingerprint'], ['observation', 'route', 'serviceTier']]) {
    reject(alter(source, path, 'another'), `Cross-route ${path.join('.')}`);
  }
  reject(alter(source, ['route', 'requestMode'], 'tool'), 'Cross-mode observation');
  reject(alter(source, ['resolution', 'match'], 'unpriced'), 'Unpriced resolution cannot retain a priced entry');
});

test('known categories, totals, status and exactness cannot be relabelled to hide missing usage', () => {
  const source = record();
  reject(alter(source, ['usage', 'promptTokens'], 1000), 'Prompt must include exclusive cache categories once');
  reject(alter(source, ['usage', 'totalTokens'], 500), 'Total must contain prompt plus charged output');
  reject(alter(source, ['usage', 'status'], 'unknown'), 'Known usage cannot be relabelled unknown');
  reject(alter(source, ['usage', 'exact'], false), 'Exactness must match diagnostic metadata');
  const unknown = record({ raw: null, entry: null });
  reject(alter(unknown, ['usage', 'status'], 'complete'), 'Missing tokens cannot be relabelled complete');
  reject(alter(unknown, ['usage', 'exact'], true), 'Missing tokens cannot be relabelled exact');
  reject(alter(unknown, ['cost', 'status'], 'free'), 'No resolved price cannot be silently free');
});
