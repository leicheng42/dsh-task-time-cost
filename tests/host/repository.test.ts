import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir, rmdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { storageFixture } from '../helpers/storage.ts';
import { EstimatorEngine } from '../../src/host/engine.ts';
import { defaultPluginConfig } from '../../src/host/config.ts';
import { emptyStreamStats } from '../../src/host/facts.ts';
import type { CallFact } from '../../src/host/facts.ts';

const fact: CallFact = { ...emptyStreamStats(), id: 'session:with/unsafe+characters:7', seq: 7, turn: 1, step: 1, startedAt: 1000, endedAt: 2000,
  route: { providerId: 'provider', modelId: 'model', reasoningEffort: 'none' }, mode: 'text', outcome: 'completed', timingSource: 'step-boundary',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } };

test('real Domain and JSON backend mount, persist canonical identities, and reopen without double counting', async () => {
  const fixture = await storageFixture();
  try {
    const repository = await fixture.open();
    assert.equal(repository.available, true, fixture.messages.join('\n'));
    const engine = new EstimatorEngine(defaultPluginConfig(), repository, []);
    engine.recordCall('session:with/unsafe+characters', fact);
    engine.recordCall('session:with/unsafe+characters', fact);
    await repository.flush();
    assert.equal(repository.available, true, fixture.messages.join('\n'));
    assert.equal(repository.calls.size, 1);
    await repository.close();
    const reopened = await fixture.open();
    assert.equal(reopened.available, true, fixture.messages.join('\n'));
    assert.deepEqual([...reopened.calls.keys()], ['session:with/unsafe+characters:7']);
    assert.equal(reopened.calls.values().next().value?.fact.usage?.inputTokens, 100);
  } finally { await fixture.close(); }
});

test('actual JSON reopen quarantines a malformed nested record and preserves healthy historical records', async () => {
  const fixture = await storageFixture();
  try {
    const repository = await fixture.open();
    const engine = new EstimatorEngine(defaultPluginConfig(), repository, []);
    engine.recordCall('healthy', fact);
    engine.recordCall('corrupt', fact);
    await repository.flush();
    await repository.close();
    const callsDirectory = join(fixture.root, 'dsh_task_time_cost', 'calls');
    const key = createHash('sha256').update('corrupt:7').digest('hex');
    const recordPath = join(callsDirectory, `${key}.json`);
    const document = JSON.parse(await readFile(recordPath, 'utf8'));
    document.record.usage.uncachedInputTokens = -100;
    await writeFile(recordPath, JSON.stringify(document), 'utf8');
    const reopened = await fixture.open();
    assert.equal(reopened.available, true, fixture.messages.join('\n'));
    assert.equal(reopened.calls.size, 1);
    assert.equal(reopened.calls.has('healthy:7'), true);
    const files = await readdir(callsDirectory);
    assert.equal(files.includes(`${key}.json`), false);
    const backup = files.find(name => name.startsWith(`${key}.json.bak.`));
    assert.ok(backup, 'actual backend must move rejected bytes aside for inspection');
    assert.deepEqual(JSON.parse(await readFile(join(callsDirectory, backup), 'utf8')), document);
    const next = new EstimatorEngine(defaultPluginConfig(), reopened, []);
    next.recordCall('after-corruption', fact);
    await reopened.flush();
    assert.equal(reopened.available, true);
    assert.equal(reopened.calls.size, 2);
  } finally { await fixture.close(); }
});

test('a stored record written by an older normalization rule is healed from its own facts', async () => {
  const fixture = await storageFixture();
  try {
    const repository = await fixture.open();
    // Arithmetic the adapter itself reported: total = prompt + output, so the
    // omitted cache-write field is a proven zero rather than an unknown split.
    const inferable: CallFact = { ...fact, usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20, totalTokens: 170 } };
    const engine = new EstimatorEngine(defaultPluginConfig(), repository, []);
    engine.recordCall('legacy', inferable);
    await repository.flush();
    const id = 'legacy:7';
    const stored = repository.calls.get(id)!;
    // Simulate bytes an earlier version wrote before the inference rules existed.
    const legacy = { ...stored, usage: { ...stored.usage, cacheWrite5mTokens: null, cacheWrite1hTokens: null,
      cacheWriteUnknownTokens: null, outputTokens: null, promptTokens: null, totalTokens: null, visibleOutputTokens: null,
      status: 'partial' as const, exact: false, diagnostics: ['unknown:output-reasoning-inclusion'] } };
    await repository.replaceCall(legacy);
    assert.equal(repository.calls.get(id)?.usage.status, 'partial');
    const next = new EstimatorEngine(defaultPluginConfig(), repository, []);
    const healed = next.recordCall('legacy', inferable);
    assert.equal(healed.usage.status, 'complete', 'the stored reading must be re-derived, not kept stale');
    assert.equal(healed.usage.outputTokens, 20);
    assert.equal(repository.calls.get(id)?.usage.status, 'complete');
    await repository.flush();
    await repository.close();
    const reopened = await fixture.open();
    assert.equal(reopened.calls.get(id)?.usage.status, 'complete', 'the healed reading must reach the stored bytes');
  } finally { await fixture.close(); }
});

test('healing a stored record keeps its historical price version instead of repricing it', async () => {
  const fixture = await storageFixture();
  try {
    const config = defaultPluginConfig();
    config.prices = [{ id: 'legacy-price', providerId: 'provider', modelId: 'model', priority: 'user-exact', currency: 'USD',
      unit: 'per-million-tokens', prices: { inputTokens: '2', outputTokens: '8' }, sourceKind: 'heuristic', sourceUrl: null,
      version: 'v1', effectiveFrom: '1970-01-01T00:00:00.000Z' }];
    const repository = await fixture.open();
    const inferable: CallFact = { ...fact, usage: { inputTokens: 100, cacheReadTokens: 50, outputTokens: 20, totalTokens: 170 } };
    const engine = new EstimatorEngine(config, repository, []);
    const billed = engine.recordCall('priced', inferable);
    const originalAmount = billed.cost.amount;
    await repository.flush();
    const stored = repository.calls.get('priced:7')!;
    await repository.replaceCall({ ...stored, usage: { ...stored.usage, cacheWrite5mTokens: null, cacheWrite1hTokens: null,
      cacheWriteUnknownTokens: null, outputTokens: null, promptTokens: null, totalTokens: null, visibleOutputTokens: null,
      status: 'partial' as const, exact: false, diagnostics: ['unknown:output-reasoning-inclusion'] } });
    const repriced = defaultPluginConfig();
    repriced.prices = [{ ...config.prices[0]!, version: 'v2', prices: { inputTokens: '200', outputTokens: '800' } }];
    const next = new EstimatorEngine(repriced, repository, []);
    const healed = next.recordCall('priced', inferable);
    assert.equal(healed.resolution.entry?.version, 'v1', 'a healed record must not adopt the current rate card');
    assert.equal(healed.cost.priceVersion, 'v1');
    assert.equal(healed.cost.amount, originalAmount);
  } finally { await fixture.close(); }
});

test('real backend write failure is contained and a repaired medium can reopen and persist again', async () => {
  const fixture = await storageFixture();
  try {
    const repository = await fixture.open();
    const callsDirectory = join(fixture.root, 'dsh_task_time_cost', 'calls');
    const key = createHash('sha256').update('blocked:7').digest('hex');
    const blockedDocument = resolve(callsDirectory, `${key}.json`);
    await mkdir(blockedDocument, { recursive: true });
    const engine = new EstimatorEngine(defaultPluginConfig(), repository, []);
    assert.doesNotThrow(() => engine.recordCall('blocked', fact));
    await repository.flush();
    assert.equal(repository.available, false);
    assert.match(repository.error ?? '', /storage-write/);
    const firstError = repository.error;
    engine.recordCall('not-blocked', fact);
    await repository.flush();
    assert.equal(repository.error, firstError);
    await repository.close();
    // Only remove the deliberately created empty directory inside this fixture.
    assert.equal(dirname(blockedDocument), resolve(fixture.root, 'dsh_task_time_cost', 'calls'));
    assert.equal(blockedDocument, resolve(callsDirectory, `${key}.json`));
    await rmdir(blockedDocument);
    const reopened = await fixture.open();
    const resumed = new EstimatorEngine(defaultPluginConfig(), reopened, []);
    resumed.recordCall('blocked', fact);
    await reopened.flush();
    assert.equal(reopened.available, true, fixture.messages.join('\n'));
    assert.equal(reopened.calls.size, 1);
  } finally { await fixture.close(); }
});
