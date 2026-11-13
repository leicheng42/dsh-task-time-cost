import test from 'node:test';
import assert from 'node:assert/strict';
import raw from '../../data/models-dev-prices.json' with { type: 'json' };
import { publicCatalogInfo, publicPriceFor, resolveWithPublicPrices } from '../../src/shared/public-prices.ts';
import { estimateCallCost, validatePrices } from '../../src/shared/pricing.ts';
import { normalizeUsage } from '../../src/shared/usage.ts';
import type { PriceEntry } from '../../src/shared/pricing.ts';
const identity = { providerId: 'magpie-responses', requestedModelId: 'codex/gpt-6.1-sol' };
const at = '2026-11-13T00:00:00Z';

test('the complete bundled catalog produces valid versioned public references', () => {
  assert.ok(publicCatalogInfo.rows > 1000);
  const entries = raw.rows.map(row => publicPriceFor({ providerId: row.provider, requestedModelId: row.model }));
  assert.ok(entries.every(entry => entry !== null));
  validatePrices(entries as PriceEntry[]);
});

test('known models behind a routing prefix receive a reference without a configured price', () => {
  const result = resolveWithPublicPrices(identity, [], [], at);
  assert.equal(result.match, 'public-catalog');
  assert.equal(result.entry?.prices.inputTokens, '2');
  assert.equal(result.entry?.prices.outputTokens, '10');
  assert.equal(result.entry?.prices.cacheReadTokens, '0.1');
  assert.equal(result.entry?.sourceUrl, 'https://models.dev/api.json');
  assert.ok(result.reasons.includes('public-reference-price-not-provider-bill'));
  assert.equal(resolveWithPublicPrices(identity, [], [], at, false).entry, null);
});

test('explicit user rates win and an explicit price alias can reach the public catalog', () => {
  const configured: PriceEntry = { ...publicPriceFor(identity)!, id: 'user-rate', providerId: identity.providerId,
    priority: 'user-exact', effectiveFrom: '2020-01-01T00:00:00Z', prices: { inputTokens: '7', outputTokens: '13' } };
  assert.equal(resolveWithPublicPrices(identity, [configured], [], at).entry?.id, 'user-rate');
  const alias = resolveWithPublicPrices({ providerId: 'private-route', requestedModelId: 'my-model' }, [], [
    { providerId: 'private-route', modelId: 'my-model', targetProviderId: 'openai', targetModelId: 'gpt-6.1-sol' },
  ], at);
  assert.equal(alias.entry?.prices.inputTokens, '2');
  assert.equal(alias.billingModelId, 'my-model');
});

test('explicit long-context tiers supersede the legacy 200k field and apply to the whole request', () => {
  const resolution = resolveWithPublicPrices(identity, [], [], at);
  const usage = (input: number) => normalizeUsage({ inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 1000, totalTokens: input + 1000 }, { schema: 'dsh', outputIncludesReasoning: true });
  assert.equal(estimateCallCost(usage(210_000), resolution).amount, '0.43');
  const large = estimateCallCost(usage(300_000), resolution);
  assert.equal(large.amount, '1.215');
  assert.deepEqual(large.appliedRuleIds, ['context-0']);
});

test('unknown models, suffix variants and an unconfirmed billing identity are not assigned a made-up rate', () => {
  for (const requestedModelId of ['not-a-real-model-987654', 'codex/gpt-6.1-sol-unlisted-suffix']) {
    assert.equal(publicPriceFor({ ...identity, requestedModelId }), null);
  }
  assert.equal(resolveWithPublicPrices({ ...identity, billingIdentityConfirmed: false }, [], [], at).entry, null);
});
