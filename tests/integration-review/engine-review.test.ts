import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import Storage from '@deepseek-ai/dsh-storage';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain';
import { EstimatorEngine } from '../../src/host/engine.ts';
import { defaultPluginConfig, validatePluginConfig } from '../../src/host/config.ts';
import type { PluginConfig } from '../../src/host/config.ts';
import { Repository } from '../../src/host/repository.ts';
import { RuntimeObservations } from '../../src/host/runtime.ts';
import { foldFacts, initialFacts } from '../../src/host/facts.ts';
import type { CallFact, TaskFact, FactsState } from '../../src/host/facts.ts';
import type { SessionEvent, SessionHeader, SessionSeq } from '@deepseek-ai/dsh-session';
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm';
import { classifyTask } from '../../src/shared/workload.ts';
import type { LiveAttempt } from '../../src/host/runtime.ts';
import { importBaselines } from '../../src/shared/baselines.ts';
import type { BaselineRecord } from '../../src/shared/baselines.ts';
import { updateWorkload } from '../../src/shared/workload.ts';
import { profileKey } from '../../src/shared/performance.ts';

const reviewRoot = dirname(fileURLToPath(import.meta.url));
const routeFact = { providerId: 'review-provider', modelId: 'review-model', reasoningEffort: 'normal' };

function configured(): PluginConfig {
  return validatePluginConfig({ ...defaultPluginConfig(), routeOverrides: {
    'review-provider': { endpointFingerprint: 'review-endpoint', serviceTier: 'standard', outputIncludesReasoning: true, cacheFieldsOmittedAreZero: true },
  } });
}

/** The actual Cordis, JSON backend and DomainFacility are used, without substitute Harness services. */
async function environment(t: TestContext, config = configured(), baselines: BaselineRecord[] = []) {
  const directory = await mkdtemp(join(reviewRoot, '.runtime-review-'));
  const ctx = new Context();
  const hub = new Storage(ctx);
  const backend = new JsonStorageBackend(directory);
  const unregister = hub.backend.register('review-json', backend);
  const facility = new DomainFacility(ctx, { backend: 'review-json' });
  const logs: string[] = [];
  let wall = 1_000_000, mono = 0;
  const repository = new Repository(message => logs.push(message), () => wall);
  const runtime = new RuntimeObservations({ wall: () => wall, monotonic: () => mono });
  let engine: EstimatorEngine | undefined;
  t.after(async () => {
    engine?.dispose();
    await repository.close();
    await facility.closeAll();
    unregister();
    await backend.close();
    await ctx.fiber.dispose();
    // Verify the resolved absolute target before removing test-owned temporary data.
    const absolute = await realpath(directory);
    assert.equal(dirname(absolute).toLowerCase(), (await realpath(reviewRoot)).toLowerCase());
    await rm(absolute, { recursive: true });
  });
  await repository.open(facility);
  assert.equal(repository.available, true, logs.join('\n'));
  engine = new EstimatorEngine(config, repository, baselines, runtime);
  return { ctx, facility, directory, repository, runtime, engine, logs,
    advance(ms: number) { wall += ms; mono += ms; }, now: () => wall };
}

function task(now: number, kind: TaskFact['taskType'] = 'question'): TaskFact {
  return { turn: 1, startSeq: 1, startedAt: now, endedAt: null, lastAt: now, state: 'running', taskType: kind,
    promptChars: 24, attachmentCount: 0, explicitOutputWords: null, userMessages: 1, scopeChanged: false,
    step: 1, stepStartedAt: now, route: routeFact, calls: [], tools: {} };
}

function callFixture(startedAt: number): { fact: CallFact; live: { attempt: LiveAttempt; endedAt: number } } {
  const endedAt = startedAt + 40_000;
  const stats = { firstContentAt: startedAt + 30_000, firstTextAt: startedAt + 30_000, lastContentAt: endedAt,
    textChars: 2_000, reasoningChars: 0, toolChars: 0, textDeltas: 2,
    usage: { inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 500, reasoningTokens: 0 }, finish: 'stop' };
  return { fact: { ...stats, id: 'review-session:10', seq: 10, turn: 1, step: 1,
    startedAt, endedAt, route: routeFact, mode: 'text', outcome: 'completed', timingSource: 'step-boundary' },
  live: { attempt: { ...stats, id: 'review-attempt', sessionId: 'review-session', turn: 1, step: 1,
    route: routeFact, startedAt, startedMono: 0, lastIndex: 1 }, endedAt } };
}

function publicPrior(): BaselineRecord {
  return { seedId: 'synthetic-review-reference', taskKind: 'unknown',
    appliesTo: { providerId: 'review-provider', endpointFingerprint: 'review-endpoint', modelId: 'review-model', reasoningEffort: 'normal', serviceTier: 'standard' },
    date: '2026-11-11', sourceUrl: 'https://example.test/synthetic-fixture', dataVersion: 'fixture-1',
    timingBasis: 'body-generation-window', statistic: 'mean', sampleCount: 20, scope: 'Synthetic acceptance fixture, not real benchmark data', sourceKind: 'public-measured',
    metrics: { firstTextMs: { mean: 30_000 }, visibleTps: { mean: 10 }, totalCallMs: { mean: 40_000 } } };
}

async function bundledBaselines(): Promise<BaselineRecord[]> {
  return importBaselines(await readFile(new URL('../../data/baselines.json', import.meta.url), 'utf8'), 'json').records;
}

test('review/reset: calibration reset preserves original per-call valuation and survives reopen', async t => {
  const config = configured();
  config.prices = [{ id: 'review-price', providerId: 'review-provider', endpointFingerprint: 'review-endpoint', modelId: 'review-model',
    priority: 'user-exact', currency: 'USD', unit: 'per-million-tokens', prices: { inputTokens: '2', outputTokens: '8' },
    sourceKind: 'heuristic', sourceUrl: null, version: 'v1', effectiveFrom: '1970-01-01T00:00:00.000Z' }];
  const env = await environment(t, config);
  const fixture = callFixture(env.now());
  env.advance(40_000);
  const original = env.engine.recordCall('review-session', fixture.fact, fixture.live);
  assert.equal(original.cost.amount, '0.006');
  assert.equal(original.cost.priceVersion, 'v1');
  await env.repository.flush();
  assert.equal(env.repository.error, null, env.logs.join('\n'));
  const before = structuredClone(env.repository.calls.get(original.id));
  env.advance(1_000);
  await env.repository.resetCalibration();
  env.engine.rebuildCalibration();
  assert.equal(env.engine.profiles.size, 0);
  assert.deepEqual(env.repository.calls.get(original.id), before, 'Reset must remove calibration eligibility, not historical usage/price/cost facts');
  await env.repository.close();
  const reopened = new Repository(message => env.logs.push(message), env.now);
  t.after(() => reopened.close());
  await reopened.open(env.facility);
  assert.equal(reopened.available, true, env.logs.join('\n'));
  assert.deepEqual(reopened.calls.get(original.id), before);
  const repricedConfig = validatePluginConfig({ ...config, prices: config.prices.map(price => ({ ...price, version: 'v2', prices: { inputTokens: '200', outputTokens: '800' } })) });
  const afterReopen = new EstimatorEngine(repricedConfig, reopened, [], env.runtime);
  const recovered = afterReopen.recordCall('review-session', fixture.fact);
  assert.equal(recovered.cost.amount, '0.006', 'Historical requests retain their resolved price, even after current rates change');
  assert.equal(recovered.cost.priceVersion, 'v1');
  afterReopen.dispose();
});

test('review/reference-price: previously unpriced usage gets a display reference without rewriting the historical ledger', async t => {
  const config = configured(); config.usePublicPriceCatalog = false;
  const env = await environment(t, config);
  const fixture = callFixture(env.now());
  fixture.fact.route = { providerId: 'magpie-responses', modelId: 'codex/gpt-6.1-sol', reasoningEffort: 'max' };
  fixture.fact.usage = { ...fixture.fact.usage, totalTokens: 1500 };
  env.advance(40_000);
  const original = env.engine.recordCall('review-session', fixture.fact);
  assert.equal(original.resolution.entry, null);
  const frozen = structuredClone(original);
  config.usePublicPriceCatalog = true;
  const current = task(fixture.fact.startedAt); current.route = fixture.fact.route; current.calls = [fixture.fact];
  const view = env.engine.persist('review-session', current, 2);
  assert.deepEqual(view.knownCost, [{ currency: 'USD', amount: '0.007' }]);
  assert.ok(view.reasons.includes('public-reference-price-not-provider-bill'));
  assert.deepEqual(env.repository.calls.get(original.id), frozen);
  await env.repository.flush(); await env.repository.close();
  const reopened = new Repository(message => env.logs.push(message), env.now); t.after(() => reopened.close());
  await reopened.open(env.facility);
  assert.deepEqual(reopened.calls.get(original.id), frozen, 'Original unpriced records and price versions stay intact');
});

test('review/retained-eta: the last valid reference survives 140 unknown revisions and a real JSON reopen', async t => {
  const config = configured();
  config.workloadTemplates = config.workloadTemplates.map(template => ({ ...template, requestCount: { low: 1, high: 1 } }));
  const env = await environment(t, config);
  const current = task(env.now());
  const first = env.engine.persist('review-session', current, 1);
  assert.ok(first.remainingMs && first.remainingMs.high > 0);
  const fixture = callFixture(env.now()); env.advance(40_000);
  env.engine.recordCall('review-session', fixture.fact); current.calls = [fixture.fact];
  for (let i = 0; i < 140; i++) { env.advance(1_000); env.engine.persist('review-session', current, i + 2); }
  const saved = env.repository.tasks.get('review-session:1')!;
  assert.equal(saved.revisions.length, 128);
  // A plan that has been consumed leaves the remaining range unknown until the
  // turn outlives its own first forecast; from then on the honest answer is a
  // corrected range rather than an eternal "unknown" (docs/DESIGN-0.4.md §3).
  const corrected = saved.revisions.filter(item => item.remainingMs !== null);
  assert.ok(corrected.length > 0, 'an overrun is corrected instead of staying unknown');
  assert.ok(corrected.every(item => item.reasons.includes('forecast-exceeded-observed-work')));
  assert.ok(corrected.every(item => item.remainingMs!.high >= 60_000));
  // The stored reference is the newest non-null forecast, which is now the corrected one.
  assert.deepEqual(saved.lastForecast?.remainingMs, corrected.at(-1)!.remainingMs);
  await env.repository.flush(); await env.repository.close();
  const reopened = new Repository(message => env.logs.push(message), env.now); t.after(() => reopened.close());
  await reopened.open(env.facility);
  assert.deepEqual(reopened.tasks.get(saved.id)?.lastForecast, saved.lastForecast);
});

test('review/prior: first local observation updates the matched public prior, not default engineering values', async t => {
  const env = await environment(t, configured(), [publicPrior()]);
  const fixture = callFixture(env.now());
  env.advance(40_000);
  const recorded = env.engine.recordCall('review-session', fixture.fact, fixture.live);
  const profile = env.engine.profiles.get(profileKey(recorded.route));
  assert.ok(profile);
  assert.equal(profile.firstTextMs, 30_000, '30s prior plus 30s observation must remain 30s at alpha .2');
  assert.equal(profile.totalCallMs, 40_000);
  assert.ok(Math.abs(profile.decayedVisibleTokens / profile.decayedVisibleSeconds - 108 / 2.8) < 1e-9);
  await env.repository.flush();
  assert.equal(env.repository.error, null, env.logs.join('\n'));
});

test('review/config: user workload template is effective with the bundled engineering baselines', async t => {
  const config = configured();
  config.workloadTemplates = config.workloadTemplates.map(template => template.kind === 'question'
    ? { ...template, requestCount: { low: 3, high: 3 }, visibleOutputTokens: { low: 60, high: 60 }, toolMs: { low: 0, high: 0 } } : template);
  const env = await environment(t, config, await bundledBaselines());
  const estimate = env.engine.estimate('review-session', task(env.now()), 1, true);
  assert.deepEqual(estimate.calls.expected, { low: 3, high: 3 });
});

test('review/config: configured engineering performance centers are not hidden by bundled default values', async t => {
  const config = validatePluginConfig({ ...configured(), heuristicFirstTextMs: 90_000, heuristicVisibleTps: 7, heuristicTotalCallMs: 120_000 });
  const env = await environment(t, config, await bundledBaselines());
  const estimate = env.engine.estimate('review-session', task(env.now()), 1, true);
  assert.ok(estimate.performance);
  assert.equal(estimate.performance.firstTextMs, 90_000);
  assert.equal(estimate.performance.visibleTps, 7);
  assert.equal(estimate.performance.totalCallMs, 120_000);
});

test('review/reset: rebuild invalidates cached workload plans as well as profile maps', async t => {
  const env = await environment(t);
  const learned = updateWorkload(null, { kind: 'writing', outcome: 'completed', requestCount: 8, visibleOutputTokens: 4_000, toolMs: 10_000, observedAtMs: env.now(), dataComplete: true });
  assert.ok(learned.history);
  env.engine.workloadHistory.set('writing', learned.history);
  const activeTask = task(env.now(), 'writing');
  const before = env.engine.estimate('review-session', activeTask, 1, true);
  assert.equal(before.workloadSamples, 1);
  env.advance(1_000);
  await env.repository.resetCalibration();
  env.engine.rebuildCalibration();
  assert.equal(env.engine.workloadHistory.size, 0);
  const after = env.engine.estimate('review-session', activeTask, 1, true);
  assert.equal(after.workloadSamples, 0, 'Reset must not leave a local-calibrated plan in the per-turn cache');
});

test('review/reset: calls saved in the reset millisecond do not resurrect calibration', async t => {
  const env = await environment(t);
  const fixture = callFixture(env.now());
  env.advance(40_000);
  const recorded = env.engine.recordCall('review-session', fixture.fact, fixture.live);
  assert.equal(env.engine.profiles.size, 1);
  await env.repository.flush();
  // No clock advance: a user can reset after settlement in the same Date.now() millisecond.
  await env.repository.resetCalibration();
  assert.equal(recorded.savedAt, env.repository.resetAt);
  env.engine.rebuildCalibration();
  assert.equal(env.engine.profiles.size, 0, 'The reset cutoff includes all observations already present when reset was requested');
  assert.ok(env.repository.calls.has(recorded.id), 'The accounting record itself must remain');
});

test('review/prior: stale local bucket starts from the selected prior on its next observation', async t => {
  const env = await environment(t, configured(), [publicPrior()]);
  const first = callFixture(env.now());
  first.fact.firstContentAt = first.fact.firstTextAt = first.fact.startedAt + 10_000;
  first.live.attempt.firstContentAt = first.live.attempt.firstTextAt = first.fact.firstTextAt;
  env.advance(40_000);
  env.engine.recordCall('review-session', first.fact, first.live);
  env.advance(8 * 24 * 60 * 60 * 1_000);
  const next = callFixture(env.now());
  next.fact.seq = 20; next.fact.id = 'review-session:20'; next.live.attempt.id = 'review-attempt-2';
  env.advance(40_000);
  const recorded = env.engine.recordCall('review-session', next.fact, next.live);
  const profile = env.engine.profiles.get(profileKey(recorded.route));
  assert.ok(profile);
  assert.equal(profile.firstTextMs, 30_000, 'After eight idle days, 30s public prior plus 30s new observation remains 30s');
});

test('review/R05: projection failure makes the current prediction unavailable', async t => {
  const env = await environment(t);
  const activeTask = task(env.now());
  const state: FactsState = { sessionId: 'review-session', inheritedEventCount: 0, lastSeq: 2, currentTurn: 1, pendingPrompt: null,
    route: routeFact, tasks: { '1': activeTask }, view: { revision: 2, currentTurn: 1 }, error: 'projection-fold-failed' };
  assert.doesNotThrow(() => env.engine.onDurable('review-session', state, 'user/message'));
  const estimate = env.engine.estimate('review-session', activeTask, state.lastSeq, true);
  assert.ok(estimate.error, 'A failed session projection must not still advertise a normal estimate');
  assert.equal(estimate.remainingMs, null);
});

test('review/facts: user prompt before turn/start supplies first-turn features without storing content', () => {
  const header = { id: 'review-session', version: 4, createdAt: 1_000, isSeeded: false } as SessionHeader;
  const prompt = '请写1000字故事。review-private-value-must-not-persist';
  const classify = (text: string) => classifyTask({ prompt: text, currentInputTokens: null }).kind;
  function event(type: string, seq: number, time: number, data: unknown): SessionEvent { return { type, seq, time, data } as SessionEvent; }
  let state = initialFacts(header, 0);
  state = foldFacts(state, event('user/message', 0, 1_010, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }), classify);
  state = foldFacts(state, event('turn/start', 1, 1_020, { turn: 1 }), classify);
  assert.equal(state.tasks['1'].taskType, 'writing');
  assert.equal(state.tasks['1'].promptChars, prompt.length);
  assert.equal(state.tasks['1'].explicitOutputWords, 1000);
  assert.equal(state.tasks['1'].userMessages, 1);
  assert.equal(state.tasks['1'].scopeChanged, false);
  assert.ok(!JSON.stringify(state).includes('review-private-value-must-not-persist'));
  const replay = foldFacts(state, event('user/message', 0, 1_010, { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] }), classify);
  assert.equal(replay, state);
});

test('host/settlement: final durable usage replaces partial live usage and final Token totals are retained', async t => {
  const env = await environment(t);
  const current = task(env.now());
  const state = { ...initialFacts({ id: 'review-session', version: 4, createdAt: env.now(), isSeeded: false } as SessionHeader, 0),
    currentTurn: 1, lastSeq: 1, tasks: { '1': current } };
  assert.equal(env.engine.estimate('review-session', current, 0, true).initial, null, 'Enabling mid-task cannot recreate an initial forecast');
  env.engine.onDurable('review-session', state, 'turn/start');
  env.engine.setInput('review-session', 1, 1_000);
  const initial = env.engine.persist('review-session', current, 1);
  assert.ok(initial.initial);
  const fixture = callFixture(env.now());
  fixture.live.attempt.usage = { ...fixture.live.attempt.usage, outputTokens: 100 };
  env.advance(40_000);
  const record = env.engine.recordCall('review-session', fixture.fact, fixture.live);
  assert.equal(record.usage.outputTokens, 500);
  assert.equal(record.usage.totalTokens, 1_500);
  const finished = { ...current, calls: [fixture.fact], endedAt: env.now(), state: 'completed' as const };
  const final = env.engine.persist('review-session', finished, 10);
  assert.deepEqual(final.estimatedTotalTokens, { low: 1_500, high: 1_500 });
  assert.deepEqual(final.initial, initial.initial);
  assert.equal(env.repository.calls.size, 1);
  const revisionCount = env.repository.tasks.get(final.taskKey)!.revisions.length;
  env.runtime.clear();
  const replayed = env.engine.persist('review-session', finished, 10);
  assert.deepEqual(replayed, final);
  assert.equal(env.repository.tasks.get(final.taskKey)!.revisions.length, revisionCount, 'Replaying an unchanged final source does not append another forecast');
});

test('host/settlement: reading a retired final snapshot migrates it once and survives reopen', async t => {
  const config = liveConfig(), env = await environment(t, config);
  const current = task(env.now());
  env.engine.onDurable('review-session', liveState(current), 'turn/start');
  env.engine.setInput('review-session', 1, 1_000);
  env.engine.persist('review-session', current, 1);
  const fixture = callFixture(env.now());
  const call = env.engine.recordCall('review-session', fixture.fact, fixture.live);
  const originalResolution = structuredClone(call.resolution);
  env.advance(40_000);
  const finished = { ...current, calls: [fixture.fact], endedAt: env.now(), state: 'completed' as const };
  const final = env.engine.persist('review-session', finished, 10);
  assert.equal(final.observedTokens, 1_500);
  assert.equal(final.observedTokenStatus, 'complete');
  const stored = structuredClone(env.repository.tasks.get(final.taskKey)!);
  const stale = { ...stored.current, algorithmVersion: 'p0-0.1.0', observedTokens: null, observedTokenStatus: 'partial' as const };
  await env.repository.saveTask({ ...stored, current: stale });
  assert.equal(env.engine.view().diagnostics.some(diagnostic => diagnostic.code === 'history-recompute-pending'), true, 'Unloaded historical summaries are explicitly marked as pending');
  // Changing today's catalog must not reprice facts while healing a summary.
  env.engine.config = validatePluginConfig({ ...config, prices: config.prices.map(price => ({ ...price, version: 'new-price', prices: { inputTokens: '200', outputTokens: '800' } })) });
  const refreshed = env.engine.estimate('review-session', finished, 10, true);
  assert.equal(refreshed.algorithmVersion, final.algorithmVersion);
  assert.equal(refreshed.observedTokens, 1_500);
  assert.equal(refreshed.observedTokenStatus, 'complete');
  assert.deepEqual(refreshed.initial, final.initial);
  assert.deepEqual(refreshed.knownCost, final.knownCost);
  assert.equal(env.engine.view().diagnostics.some(diagnostic => diagnostic.code === 'history-recompute-pending'), false);
  await env.repository.flush();
  const migrated = env.repository.tasks.get(final.taskKey)!;
  assert.deepEqual(migrated.current, refreshed, 'A read alone writes back the corrected summary');
  assert.deepEqual(migrated.revisions.slice(0, -1), stored.revisions);
  assert.equal(migrated.revisions.length, stored.revisions.length + 1);
  env.engine.persist('review-session', finished, 10);
  assert.equal(env.repository.tasks.get(final.taskKey)!.revisions.length, migrated.revisions.length, 'A following checkpoint does not duplicate the migration revision');
  assert.deepEqual(env.repository.calls.get(call.id)!.resolution, originalResolution);
  await env.repository.close();
  const reopened = new Repository(message => env.logs.push(message), env.now);
  t.after(() => reopened.close());
  await reopened.open(env.facility);
  assert.equal(reopened.available, true, env.logs.join('\n'));
  assert.deepEqual(reopened.tasks.get(final.taskKey), migrated, 'Corrected values, initial forecast and revision history survive a real JSON backend reopen');
  assert.deepEqual(reopened.calls.get(call.id)!.resolution, originalResolution);
});

test('host/usage: a known subtotal never becomes a complete task token range', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now());
  const known = callFixture(env.now()).fact;
  const unknown = { ...callFixture(env.now() + 40_000).fact, id: 'review-session:20', seq: 20, step: 2, usage: null };
  env.engine.recordCall('review-session', known);
  env.engine.recordCall('review-session', unknown);
  current.calls = [known, unknown];
  env.advance(80_000);
  const running = env.engine.estimate('review-session', current, 20, true);
  assert.equal(running.observedTokens, 1_500);
  assert.equal(running.observedTokenStatus, 'partial');
  assert.equal(running.estimatedTotalTokens, null, 'Missing settled usage leaves the whole-task forecast unknown');
  const final = env.engine.persist('review-session', { ...current, endedAt: env.now(), state: 'completed' }, 21);
  assert.equal(final.observedTokens, 1_500, 'The reported request remains visible');
  assert.equal(final.observedTokenStatus, 'partial');
  assert.equal(final.estimatedTotalTokens, null, 'An unreported request is never silently counted as zero');
});

test('host/pause: a live request does not consume its remaining-time budget while the user is paused', async t => {
  const env = await environment(t);
  const current = task(env.now());
  env.runtime.startAttempt('review-session', { type: 'start', attemptId: 'waiting-attempt' as LlmAttemptId, revision: 1, turn: 1, step: 1 }, routeFact);
  env.advance(10_000);
  const before = env.engine.estimate('review-session', current, 1, true);
  assert.ok(before.remainingMs);
  const resume = env.runtime.pause('review-session', 1);
  env.advance(300_000);
  const paused = env.engine.estimate('review-session', current, 2, true);
  assert.equal(paused.state, 'waiting_user');
  assert.equal(paused.elapsedPausedMs, 300_000);
  assert.equal(paused.elapsedActiveMs, before.elapsedActiveMs);
  assert.deepEqual(paused.remainingMs, before.remainingMs);
  resume();
});

test('host/forecast: the low request-count alternative participates in the total cost range', async t => {
  const config = configured();
  config.prices = [{ id: 'scenario-price', providerId: 'review-provider', endpointFingerprint: 'review-endpoint', modelId: 'review-model',
    priority: 'user-exact', currency: 'USD', unit: 'per-million-tokens', prices: { inputTokens: '2', outputTokens: '8' },
    sourceKind: 'heuristic', sourceUrl: null, version: 'fixture-v1', effectiveFrom: '1970-01-01T00:00:00.000Z' }];
  config.routeOverrides['review-provider'] = { ...config.routeOverrides['review-provider']!,
    forecastCacheReadRatio: { low: 0, high: 0 }, forecastCacheWrite5mTokens: { low: 0, high: 0 },
    forecastCacheWrite1hTokens: { low: 0, high: 0 }, forecastReasoningTokens: { low: 0, high: 0 } };
  config.workloadTemplates = config.workloadTemplates.map(template => template.kind === 'question'
    ? { ...template, requestCount: { low: 1, high: 3 }, visibleOutputTokens: { low: 300, high: 900 }, toolMs: { low: 0, high: 0 } } : template);
  const env = await environment(t, validatePluginConfig(config));
  env.engine.setInput('review-session', 1, 1_000);
  const estimate = env.engine.estimate('review-session', task(env.now()), 1, true);
  assert.deepEqual(estimate.estimatedTotalCost, [{ currency: 'USD', range: { low: '0.0044', high: '0.01428' } }]);
  assert.equal(estimate.forecastCostStatus, 'reference');
});

function liveConfig(): PluginConfig {
  const config = configured();
  config.prices = [{ id: 'live-price', providerId: 'review-provider', endpointFingerprint: 'review-endpoint', modelId: 'review-model',
    priority: 'user-exact', currency: 'USD', unit: 'per-million-tokens', prices: { inputTokens: '2', outputTokens: '8' },
    sourceKind: 'heuristic', sourceUrl: null, version: 'fixture-v1', effectiveFrom: '1970-01-01T00:00:00.000Z' }];
  config.routeOverrides['review-provider'] = { ...config.routeOverrides['review-provider']!, forecastCacheReadRatio: { low: 0, high: 0 },
    forecastCacheWrite5mTokens: { low: 0, high: 0 }, forecastCacheWrite1hTokens: { low: 0, high: 0 }, forecastReasoningTokens: { low: 0, high: 0 } };
  config.workloadTemplates = config.workloadTemplates.map(template => template.kind === 'question'
    ? { ...template, requestCount: { low: 1, high: 1 }, visibleOutputTokens: { low: 500, high: 500 }, toolMs: { low: 0, high: 0 } } : template);
  return validatePluginConfig(config);
}
function liveState(current: TaskFact): FactsState {
  return { ...initialFacts({ id: 'review-session', version: 4, createdAt: current.startedAt, isSeeded: false } as SessionHeader, 0),
    route: routeFact, currentTurn: 1, lastSeq: 1, tasks: { '1': current } };
}

test('host/live: cumulative usage updates observed totals without double charging a forecast or settlement', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now()), state = liveState(current);
  const attemptId = 'live-usage-attempt' as LlmAttemptId;
  env.engine.setInput('review-session', 1, 1_000);
  env.engine.onStream('review-session', { type: 'start', attemptId, revision: 1, turn: 1, step: 1 }, state);
  env.advance(1_000);
  env.engine.onStream('review-session', { type: 'chunk', attemptId, revision: 1, index: 0, time: env.now(),
    chunk: { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, state);
  const live = env.engine.estimate('review-session', current, 1, true);
  assert.equal(live.observedTokens, 1_100);
  assert.equal(live.tokens.output, 100);
  assert.deepEqual(live.estimatedRemainingOutputTokens, { low: 400, high: 400 }, 'Already generated output must leave the remaining budget');
  assert.deepEqual(live.knownCost, [{ currency: 'USD', amount: '0.0028' }]);
  assert.deepEqual(live.estimatedTotalCost, [{ currency: 'USD', range: { low: '0.006', high: '0.006' } }]);
  assert.deepEqual(live.estimatedTotalTokens, { low: 1_500, high: 1_500 });
  env.engine.onStream('review-session', { type: 'chunk', attemptId, revision: 1, index: 1, time: env.now(),
    chunk: { type: 'usage', usage: { inputTokens: 1_000, outputTokens: 150, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }, state);
  const next = env.engine.estimate('review-session', current, 2, true);
  assert.equal(next.observedTokens, 1_150, 'Cumulative snapshots replace previous counters');
  assert.deepEqual(next.estimatedRemainingOutputTokens, { low: 350, high: 350 }, 'Successive cumulative usage replaces, rather than subtracts twice');
  assert.deepEqual(next.knownCost, [{ currency: 'USD', amount: '0.0032' }]);
  const fixture = callFixture(current.startedAt);
  current.calls.push(fixture.fact);
  state.lastSeq = fixture.fact.seq;
  env.engine.onDurable('review-session', state, 'assistant/message');
  const pending = env.engine.estimate('review-session', current, 10, true);
  assert.equal(pending.calls.completed + pending.calls.active, 1, 'The durable event and its still-open stream are one request');
  assert.equal(pending.observedTokens, 1_150);
  env.advance(39_000);
  env.engine.onStream('review-session', { type: 'end', attemptId, revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: fixture.fact.seq as SessionSeq } }, state);
  current.endedAt = env.now(); current.state = 'completed';
  const final = env.engine.persist('review-session', current, 11);
  assert.equal(final.calls.completed, 1); assert.equal(final.calls.active, 0);
  assert.equal(final.observedTokens, 1_500);
  assert.deepEqual(final.knownCost, [{ currency: 'USD', amount: '0.006' }]);
  assert.deepEqual(final.estimatedTotalCost, [{ currency: 'USD', range: { low: '0.006', high: '0.006' } }]);
  assert.equal(env.repository.calls.size, 1);
});

test('host/input: the next actual request reanchors context growth while the workload plan remains valid', async t => {
  const config = liveConfig();
  config.workloadTemplates = config.workloadTemplates.map(template => template.kind === 'question'
    ? { ...template, requestCount: { low: 2, high: 2 } } : template);
  const env = await environment(t, config), current = task(env.now());
  env.engine.setInput('review-session', 1, 1_000);
  const first = callFixture(env.now()); env.advance(40_000);
  env.engine.recordCall('review-session', first.fact, first.live); current.calls.push(first.fact); current.step = 2;
  env.engine.setInput('review-session', 1, 10_000);
  env.engine.onStream('review-session', { type: 'start', attemptId: 'expanded-input-attempt' as LlmAttemptId, revision: 2, turn: 1, step: 2 }, liveState(current));
  const estimate = env.engine.estimate('review-session', current, 11, true);
  assert.deepEqual(estimate.calls.expected, { low: 2, high: 2 });
  // The two-call plan reserves 60% of its 500 output tokens for the final call:
  // 1,500 settled + 10,000 reanchored input + 300 future output.
  assert.deepEqual(estimate.estimatedTotalTokens, { low: 11_800, high: 11_800 });
  assert.deepEqual(estimate.estimatedTotalCost, [{ currency: 'USD', range: { low: '0.0284', high: '0.0284' } }]);
  assert.equal(estimate.reasons.includes('observed-call-count-expanded-workload'), false, 'The second request still belongs to the original two-call plan');
  env.engine.config.routeOverrides['review-provider']!.forecastReasoningTokens = null;
  const unknown = env.engine.estimate('review-session', current, 12, true);
  assert.equal(unknown.estimatedTotalTokens, null, 'Unknown future reasoning must not become zero');
  assert.deepEqual(unknown.estimatedRemainingOutputTokens, { low: 300, high: 300 }, 'The separate visible output budget is known even when complete token totals are unknown');
  assert.equal(unknown.estimatedTotalCost, null);
});

test('host/workload: the first successful observation updates the configured template centers', async t => {
  const config = liveConfig();
  config.workloadTemplates = config.workloadTemplates.map(template => template.kind === 'question'
    ? { ...template, requestCount: { low: 10, high: 10 }, visibleOutputTokens: { low: 10_000, high: 10_000 }, toolMs: { low: 20_000, high: 20_000 } } : template);
  const env = await environment(t, config), current = task(env.now()), fixture = callFixture(env.now());
  env.advance(40_000); env.engine.recordCall('review-session', fixture.fact, fixture.live);
  current.calls.push(fixture.fact); current.endedAt = env.now(); current.state = 'completed';
  env.engine.persist('review-session', current, 11);
  const learned = env.engine.workloadHistory.get('question'); assert.ok(learned);
  assert.equal(learned.samples, 1); assert.equal(learned.requestCount, 8.2);
  assert.equal(learned.visibleOutputTokens, 8_100); assert.equal(learned.toolMs, 16_000);
});

test('review/human-wait: durable question waits survive a remount and do not become tool work', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now() - 20_000);
  current.tools = { q: { id: 'q', name: 'functions.ask_user_question', startedAt: env.now() - 15_000, endedAt: env.now() - 5_000, failed: false } };
  const first = env.engine.persist('durable-question', current, 1);
  assert.equal(first.elapsedWallMs, 20_000);
  assert.equal(first.elapsedPausedMs, 10_000);
  assert.equal(first.elapsedActiveMs, 10_000);
  assert.equal(first.tools.workMs, 0);
  await env.repository.flush();
  env.advance(1_000); env.runtime.clear();
  const afterRemount = env.engine.estimate('durable-question', current, 2, true);
  assert.equal(afterRemount.elapsedPausedMs, 10_000, 'Persisted aggregate and durable interval must not be counted twice');
  assert.equal(afterRemount.elapsedActiveMs, 11_000);
});

test('review/initial-goal: a large first goal cannot be replaced by a short turn plan', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now());
  current.taskType = 'code'; current.workloadScale = 'program'; current.goalId = 'goal-test';
  const initial = env.engine.estimate('initial-goal', current, 1, true);
  assert.ok(initial.remainingTypicalMs! >= 3_600_000);
  assert.equal(initial.forecastScope, 'whole_goal');
  current.aiPlan = { remainingCalls: { low: 1, high: 2 }, remainingOutputTokens: { low: 200, high: 800 },
    remainingToolSeconds: { low: 0, high: 5 }, stage: 'planning', afterCalls: 0, submittedAt: env.now(), scope: 'current_turn' };
  assert.ok(env.engine.estimate('initial-goal', current, 2, true).remainingTypicalMs! >= 3_600_000);
  current.aiPlan.scope = 'whole_goal';
  assert.ok(env.engine.estimate('initial-goal', current, 3, true).remainingTypicalMs! >= 3_600_000, 'Claiming whole_goal cannot turn a new complete system into two requests');
  current.aiPlan = { ...current.aiPlan, remainingCalls: { low: 100, high: 160 }, remainingOutputTokens: { low: 20_000, high: 40_000 }, remainingToolSeconds: { low: 1_800, high: 3_600 } };
  const revised = env.engine.estimate('initial-goal', current, 4, true);
  assert.ok(revised.reasons.includes('ai-workload-plan-reference'));
  assert.ok(revised.remainingTypicalMs! > 1_800_000);
});

test('review/goal-continuation: prior work permits a small finishing plan, while an edited goal starts fresh', async t => {
  const env = await environment(t, liveConfig()), prior = task(env.now() - 100_000, 'code');
  prior.workloadScale = 'program'; prior.goalId = 'continued-goal'; prior.endedAt = env.now() - 1;
  prior.calls = [callFixture(env.now() - 90_000).fact];
  let state = liveState(prior);
  state.goal = { id: 'continued-goal', phase: 'active', features: { taskType: 'code', workloadScale: 'program', promptChars: 100, attachmentCount: 0, explicitOutputWords: null, userMessages: 0 } };
  state = foldFacts(state, { type: 'turn/start', seq: 100, time: env.now(), data: { turn: 2 } } as unknown as SessionEvent, () => 'code');
  const finishing = state.tasks['2']!;
  finishing.aiPlan = { remainingCalls: { low: 1, high: 2 }, remainingOutputTokens: { low: 100, high: 400 }, remainingToolSeconds: { low: 0, high: 1 }, stage: 'finishing', afterCalls: 0, submittedAt: env.now(), scope: 'whole_goal' };
  assert.ok(env.engine.estimate('goal-continuation', finishing, 1, true).reasons.includes('ai-workload-plan-reference'), 'Continuing a worked-on Goal may have only a small final step left');
  state = foldFacts(state, { type: 'goal/change', seq: 101, time: env.now(), data: { kind: 'goal/change', version: 1, operation: 'edit', goal: { id: 'continued-goal', revision: 2, objective: '开发完整四端系统，真实API和共享后端，E2E验收并交付', phase: 'active', maxGoalRounds: 16 }, roundsStarted: 1, createdAt: 1, updatedAt: env.now() } } as unknown as SessionEvent, () => 'code');
  state = foldFacts(state, { type: 'turn/start', seq: 102, time: env.now(), data: { turn: 3 } } as unknown as SessionEvent, () => 'code');
  state.tasks['3']!.aiPlan = structuredClone(finishing.aiPlan);
  assert.ok(env.engine.estimate('goal-continuation', state.tasks['3']!, 2, true).reasons.includes('ai-plan-too-small-for-initial-scope'), 'Work before an objective edit cannot bypass protection for the new objective');
});

test('review/replan: a human follow-up cannot replace a large AI plan with a short template', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now());
  current.aiPlan = { remainingCalls: { low: 40, high: 50 }, remainingOutputTokens: { low: 8_000, high: 12_000 },
    remainingToolSeconds: { low: 300, high: 600 }, stage: 'implementation', afterCalls: 0, submittedAt: env.now() };
  const planned = env.engine.persist('replan-session', current, 1);
  assert.ok(planned.remainingMs && planned.remainingMs.high > 600_000);
  assert.ok(planned.remainingTypicalMs && planned.remainingTypicalMs > 300_000);
  await env.repository.flush();
  current.scopeChanged = true; delete current.aiPlan;
  const stale = env.engine.persist('replan-session', current, 2);
  assert.equal(stale.remainingMs, null, 'No short template should replace invalidated work');
  assert.equal(stale.remainingTypicalMs, null);
  assert.equal(stale.estimatedRemainingOutputTokens, null);
  assert.equal(stale.estimatedTotalCost, null);
  const retained = env.repository.tasks.get(stale.taskKey)!.lastForecast!;
  assert.equal(retained.remainingTypicalMs, planned.remainingTypicalMs, 'Keep the last numeric reference independently');
  assert.deepEqual(retained.remainingMs, planned.remainingMs);
  current.aiPlan = { remainingCalls: { low: 35, high: 45 }, remainingOutputTokens: { low: 7_000, high: 10_000 },
    remainingToolSeconds: { low: 240, high: 500 }, stage: 'implementation', afterCalls: 0, submittedAt: env.now() };
  assert.ok(env.engine.estimate('replan-session', current, 3, true).remainingTypicalMs! > 300_000);
});

test('host/lifecycle: session cleanup releases local clocks, attempts and errors without losing another session', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now()), state = liveState(current);
  env.engine.onDurable('review-session', state, 'turn/start');
  env.engine.setInput('review-session', 1, 1_000);
  env.engine.onStream('review-session', { type: 'start', attemptId: 'cleanup-a' as LlmAttemptId, revision: 1, turn: 1, step: 1 }, state);
  env.runtime.startAttempt('other-session', { type: 'start', attemptId: 'cleanup-b' as LlmAttemptId, revision: 1, turn: 1, step: 1 }, routeFact);
  env.engine.onDurable('review-session', { ...state, error: 'projection-fold-failed' }, 'user/message');
  env.engine.cleanupSession('review-session');
  assert.equal(env.runtime.activeAttempts('review-session', 1).length, 0);
  assert.equal(env.runtime.activeAttempts('other-session', 1).length, 1);
  assert.ok(!env.runtime.tasks.has('review-session:1'));
  const restored = env.engine.estimate('review-session', current, 12, true);
  assert.equal(restored.error, null); assert.equal(restored.initial, null);
  env.engine.dispose(); assert.equal(env.runtime.attempts.size, 0); assert.equal(env.runtime.tasks.size, 0);
});

test('review/future-mode: future requests use the observed route mode and its duration samples', async t => {
  const config = liveConfig();
  config.workloadTemplates = config.workloadTemplates.map(template => template.kind === 'question'
    ? { ...template, requestCount: { low: 5, high: 5 } } : template);
  const env = await environment(t, config);
  for (let index = 0; index < 5; index++) {
    const fixture = callFixture(env.now());
    fixture.fact.mode = 'tool'; fixture.fact.textChars = 0; fixture.fact.toolChars = 2_000; fixture.fact.firstTextAt = null;
    fixture.live.attempt.textChars = 0; fixture.live.attempt.toolChars = 2_000; fixture.live.attempt.firstTextAt = null;
    env.advance(40_000);
    env.engine.recordCall(`mode-history-${index}`, fixture.fact, fixture.live);
  }
  const current = task(env.now());
  const initial = env.engine.estimate('mode-current', current, 1, true);
  assert.equal(initial.localPerformanceSamples, 0, 'No request mode is known at cold task start');
  const observed = callFixture(env.now()).fact; observed.mode = 'tool';
  current.calls = [observed]; env.advance(40_000);
  const revised = env.engine.estimate('mode-current', current, 2, true);
  assert.equal(revised.localPerformanceSamples, 5, 'Future requests must not remain unknown-mode and bypass calibrated samples');
  assert.deepEqual(revised.remainingMs, { low: 160_000, high: 160_000 }, 'Four future calls use observed 40s durations instead of arbitrary 0.5/2.5 multipliers');
});

test('review/profiles: calibration read exposes measured latency, speed, samples and the newest observation time', async t => {
  const env = await environment(t);
  assert.deepEqual(env.engine.view().profiles, [], 'No route appears before a local observation');
  const fixture = callFixture(env.now());
  env.advance(40_000);
  env.engine.recordCall('review-session', fixture.fact, fixture.live);
  const [profile] = env.engine.view().profiles;
  assert.ok(profile, 'A recorded call creates one calibration row');
  assert.equal(profile.providerId, 'review-provider');
  assert.equal(profile.modelId, 'review-model');
  assert.equal(profile.requestMode, 'text');
  assert.equal(profile.totalCallSamples, 1);
  assert.equal(profile.sourceKind, 'local-measured', 'An accepted local sample must not be attributed to its initial prior');
  assert.equal(profile.firstTextSamples, 1);
  assert.equal(profile.speedSamples, 1);
  assert.ok(profile.firstTextMs !== null && profile.firstTextMs >= 0);
  assert.ok(profile.visibleTps !== null && profile.visibleTps > 0);
  assert.equal(profile.testedAt, fixture.fact.endedAt, 'The row time is the real observation end, not a snapshot update');
  assert.deepEqual(JSON.parse(JSON.stringify(profile)), profile, 'The management row must be JSON-safe');
  assert.equal('observedAttemptIds' in profile, false, 'Dedup identities stay out of a calibration read');
  assert.equal('firstTextWaitSamplesMs' in profile, false, 'Raw samples stay out of a calibration read');
  await env.repository.flush();
  assert.equal(env.repository.error, null, env.logs.join('\n'));
});

test('review/continuation: a consumed plan without history falls back to a labelled band instead of staying blank', async t => {
  const env = await environment(t, liveConfig()), current = task(env.now());
  const fixture = callFixture(env.now());
  current.calls = [fixture.fact];
  env.advance(20 * 60_000);
  const before = env.engine.estimate('review-session', current, 10, true);
  // 0.8: a consumed plan with no history used to return null forever. A running
  // turn must still answer, so it falls back to a wide band and says so.
  assert.ok(before.remainingMs, 'A long turn never leaves the panel blank');
  assert.ok(before.remainingMs!.high >= before.remainingMs!.low);
  assert.ok(before.reasons.some(reason => reason === 'initial-band-fallback' || reason === 'elapsed-only-band'));
  assert.ok(before.reasons.includes('continuation-history-insufficient'));
  env.engine.onStream('review-session', { type: 'start', attemptId: 'continuation-attempt' as LlmAttemptId, revision: 1, turn: 1, step: 2 }, liveState(current));
  const during = env.engine.estimate('review-session', current, 11, true);
  assert.ok(during.remainingMs, 'A new request keeps the labelled fallback rather than reviving the consumed one-call budget');
  assert.deepEqual(during.calls.expected, { low: 2, high: 2 }, 'The observed request still expands both cost scenarios without turning them into a complete forecast');
  assert.equal(during.estimatedTotalCost, null);
  assert.equal(during.forecastCostStatus, 'unavailable');
});

test('review/continuation: matching finished tasks replace a consumed plan, while another route cannot supply a forecast', async t => {
  const env = await environment(t, liveConfig());
  for (const [index, minutes] of [30, 32, 35, 38, 40].entries()) {
    const historical = task(1, 'question');
    historical.endedAt = historical.startedAt + minutes * 60_000;
    historical.state = 'completed';
    historical.calls = [callFixture(1).fact, { ...callFixture(1).fact, id: 'second', seq: 11, step: 2 }];
    const snapshot = env.engine.estimate(`history-${index}`, historical, 12, true);
    await env.repository.saveTask({ id: snapshot.taskKey, savedAt: snapshot.updatedAt, current: snapshot, revisions: [snapshot], learned: null });
  }
  await env.repository.flush();
  // Start strictly after all training tasks, to prevent future-data leakage.
  env.advance(4_000_000);
  const current = task(env.now());
  current.calls = [callFixture(env.now()).fact];
  env.advance(20 * 60_000);
  const estimate = env.engine.estimate('review-session', current, 12, true);
  assert.deepEqual(estimate.remainingMs, { low: 10 * 60_000, high: 20 * 60_000 });
  assert.ok(estimate.reasons.includes('continuation-local-task-history'));
  assert.equal(estimate.estimatedTotalCost, null, 'Duration history is not a future token/cost budget');
  const anotherRoute = { ...current, route: { ...routeFact, modelId: 'another-model' } };
  const otherRoute = env.engine.estimate('another-session', anotherRoute, 12, true);
  // Another route has no matching history, but the labelled fallback still answers.
  assert.ok(otherRoute.remainingMs, 'no matching history still yields a labelled band');
  assert.ok(otherRoute.reasons.some(reason => reason.endsWith('-band')));
  assert.equal(env.repository.error, null, env.logs.join('\n'));
});

test('review/route: an unresolved endpoint keeps one stable unknown identity instead of a per-process bucket', async t => {
  const env = await environment(t, validatePluginConfig({ ...defaultPluginConfig() }));
  const route = env.engine.route({ providerId: 'review-provider', modelId: 'review-model', reasoningEffort: 'normal' }, 'text');
  assert.equal(route.endpointFingerprint, 'unknown', 'An unresolved endpoint must not receive a random per-process identity');
  assert.equal(route.mixedRoute, true);
  const fixture = callFixture(env.now());
  env.advance(40_000);
  const recorded = env.engine.recordCall('review-session', fixture.fact, fixture.live);
  assert.equal(recorded.route.endpointFingerprint, 'unknown');
  const [profile] = env.engine.view().profiles;
  assert.ok(profile);
  assert.equal(profile.endpointFingerprint, 'unknown', 'A remount or restart must not create a second bucket for the same unresolved route');
  assert.equal(profile.totalCallSamples, 1);
  await env.repository.flush();
  assert.equal(env.repository.error, null, env.logs.join('\n'));
});

test('review/workload: empirical budgets use only eligible prior tasks on the same route and survive JSON reopen', async t => {
  const env = await environment(t);
  for (let index = 0; index < 9; index++) {
    const historical = task(1, 'code');
    historical.endedAt = 100_000; historical.state = 'completed';
    const view = env.engine.estimate(`distribution-${index}`, historical, 1, true);
    if (index >= 5) view.performance = { ...view.performance!, modelId: 'other-model' };
    if (index === 8) { view.performance!.modelId = routeFact.modelId; view.endedAt = env.now() + 100_000; }
    await env.repository.saveTask({ id: view.taskKey, savedAt: view.endedAt!, current: view, revisions: [view],
      learned: { calls: index < 5 ? 8 : 100, visibleOutputTokens: 2_400, toolWorkMs: 30_000, eligible: index !== 7 } });
  }
  const current = task(env.now(), 'code');
  const estimate = env.engine.estimate('review-session', current, 1, true);
  assert.deepEqual(estimate.calls.expected, { low: 8, high: 8 });
  assert.equal(estimate.workloadSamples, 5, 'Other routes, future completions and ineligible tasks are excluded');
  assert.ok(estimate.reasons.includes('local-workload-distribution'));
  await env.repository.flush(); await env.repository.close();
  const reopened = new Repository(message => env.logs.push(message), env.now); t.after(() => reopened.close());
  await reopened.open(env.facility);
  const restored = new EstimatorEngine(configured(), reopened, [], env.runtime); t.after(() => restored.dispose());
  assert.deepEqual(restored.estimate('review-session', current, 1, true).calls.expected, estimate.calls.expected);
  assert.equal(reopened.error, null, env.logs.join('\n'));
});

test('review/attempt-scope: recycled live IDs in later Agent lifecycles keep distinct durable samples and survive JSON reopen', async t => {
  const config = configured();
  const env = await environment(t, config);
  const first = callFixture(env.now());
  env.advance(100_000);
  const second = callFixture(env.now());
  second.fact = { ...second.fact, id: 'review-session:20', seq: 20, turn: 2 };
  second.live.attempt = { ...second.live.attempt, turn: 2 };
  // The SDK guarantees a stream ID only within one Agent lifecycle. A later
  // lifecycle may reuse it, while its committed SessionSeq remains distinct.
  const one = env.engine.recordCall('review-session', first.fact, first.live);
  const two = env.engine.recordCall('review-session', second.fact, second.live);
  assert.notEqual(one.id, two.id);
  assert.equal(one.observation!.attemptId, two.observation!.attemptId, 'Raw source IDs stay intact for audit');
  const key = profileKey(one.route);
  assert.equal(env.engine.profiles.get(key)!.totalCallSamples, 2, 'Two distinct committed attempts must both calibrate');
  env.engine.recordCall('review-session', second.fact, second.live);
  assert.equal(env.engine.profiles.get(key)!.totalCallSamples, 2, 'Replaying the same durable event remains idempotent');
  await env.repository.flush();
  const canonicalCalls = (repository: Repository) => JSON.parse(JSON.stringify([...repository.calls.values()].sort((a, b) => a.id.localeCompare(b.id))));
  const before = canonicalCalls(env.repository);
  env.engine.dispose();
  await env.repository.close();
  await env.facility.closeAll();
  const reopened = new Repository(message => env.logs.push(message), env.now);
  t.after(() => reopened.close());
  await reopened.open(env.facility);
  const restored = new EstimatorEngine(config, reopened, [], env.runtime);
  t.after(() => restored.dispose());
  assert.equal(restored.profiles.get(key)!.totalCallSamples, 2, 'Persisted legacy live-ID collisions must rebuild without dropping either committed call');
  restored.rebuildCalibration();
  assert.equal(restored.profiles.get(key)!.totalCallSamples, 2);
  await reopened.flush();
  assert.deepEqual(canonicalCalls(reopened), before, 'Training-key repair must not rewrite raw attempts, usage, prices or valuation versions');
  assert.equal(reopened.error, null, env.logs.join('\n'));
});
