import raw from '../../data/models-dev-prices.json' with { type: 'json' };
import { resolvePrice } from './pricing.ts';
import type { PriceEntry, PriceIdentity, PriceResolution, PriceRule, SameAs, UnitPrices } from './pricing.ts';

type Row = { provider: string; model: string; prices: UnitPrices; rules?: PriceRule[] };
const catalog = raw as unknown as { version: string; retrievedAt: string; source: string; rows: Row[] };
export const publicCatalogInfo = { version: catalog.version, retrievedAt: catalog.retrievedAt, source: catalog.source, rows: catalog.rows.length };
// Prefer the publishing lab's list price to a reseller's rate when the route
// has no catalog provider identity. Differing reseller quotes remain ambiguous.
const labs = new Set(['openai', 'anthropic', 'google', 'deepseek', 'xai', 'mistral', 'moonshotai', 'zhipuai', 'minimax', 'alibaba', 'cohere', 'nvidia', 'meta', 'inception', 'perplexity']);
const byModel = new Map<string, Row[]>();
const qualified = new Map<string, Row>();
for (const row of catalog.rows) {
  const id = row.model.toLowerCase();
  const list = byModel.get(id) ?? []; list.push(row); byModel.set(id, list);
  qualified.set(`${row.provider}/${row.model}`.toLowerCase(), row);
}
const signature = (row: Row) => JSON.stringify([row.prices, row.rules ?? []]);
function choose(id: string, provider: string): Row | null {
  const direct = qualified.get(`${provider}/${id}`) ?? qualified.get(id);
  if (direct) return direct;
  const candidates = byModel.get(id) ?? [];
  const official = candidates.filter(row => labs.has(row.provider));
  const pool = official.length ? official : candidates;
  if (!pool.length || new Set(pool.map(signature)).size !== 1) return null;
  return pool[0];
}
export function publicPriceFor(identity: PriceIdentity): PriceEntry | null {
  if (identity.billingIdentityConfirmed === false) return null;
  const model = identity.servedModelId ?? identity.requestedModelId;
  const provider = identity.providerId.toLowerCase();
  const parts = model.toLowerCase().split('/');
  let row: Row | null = null;
  // Peel routing namespaces only when the remaining *complete* model id is in
  // the catalog. Never strip versions, suffixes, service tiers or ':free'.
  for (let i = 0; i < Math.min(parts.length, 3) && !row; i++) row = choose(parts.slice(i).join('/'), provider);
  if (!row) return null;
  return { id: `models.dev:${row.provider}/${row.model}`, providerId: '*', modelId: model, priority: 'public-catalog',
    currency: 'USD', unit: 'per-million-tokens', prices: structuredClone(row.prices), rules: structuredClone(row.rules),
    sourceKind: 'public-measured', sourceUrl: catalog.source, version: catalog.version, effectiveFrom: catalog.retrievedAt };
}

/** An as-of-today LIST-PRICE reference, never proof of a provider's invoice. */
export function resolveWithPublicPrices(identity: PriceIdentity, entries: PriceEntry[], aliases: SameAs[], at: string, enabled = true): PriceResolution {
  const configured = resolvePrice(identity, entries, aliases, at);
  if (configured.entry || !enabled || identity.billingIdentityConfirmed === false) return configured;
  let providerId = identity.providerId, modelId = identity.servedModelId ?? identity.requestedModelId;
  let aliased = false;
  for (let i = 0; i < aliases.length; i++) {
    const alias = aliases.find(item => item.providerId === providerId && item.modelId === modelId);
    if (!alias) break;
    providerId = alias.targetProviderId; modelId = alias.targetModelId; aliased = true;
  }
  const entry = publicPriceFor({ providerId, requestedModelId: modelId });
  return entry ? { entry, match: 'public-catalog', billingModelId: configured.billingModelId,
    reasons: ['public-reference-price-not-provider-bill', ...(aliased ? ['user-explicit-same-as-reference'] : [])] } : configured;
}
