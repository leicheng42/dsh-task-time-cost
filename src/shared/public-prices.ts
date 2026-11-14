import raw from '../../data/models-dev-prices.json' with { type: 'json' };
import { resolvePrice } from './pricing.ts';
import type { PriceEntry, PriceIdentity, PriceResolution, PriceRule, SameAs, UnitPrices } from './pricing.ts';

type Row = { provider: string; model: string; name?: string; prices: UnitPrices; rules?: PriceRule[] };
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
// A gateway may rename a catalog model (magpie's `auto/deepseek-v4.1-flash`
// is DeepSeek's own `deepseek-flash`, which models.dev names "DeepSeek V4.1
// Flash 1017"). The publisher's display name is the only identity link the
// catalog carries, so the bridge stays deliberately narrow: the row must come
// from a lab, the lab's own name must be the leading token of the model id
// (so resellers such as nvidia or mistral cannot lend their rate), every id
// token must prefix the display name, and more than one match is refused. Ids
// are never rewritten: `deepseek-v4-flash` does not collapse into v4.1.
const tokenize = (text: string) => text.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
const labNames: { row: Row; provider: string[]; tokens: string[] }[] = [];
for (const row of catalog.rows) {
  if (!row.name || !labs.has(row.provider)) continue;
  labNames.push({ row, provider: tokenize(row.provider), tokens: tokenize(row.name) });
}
function chooseByDisplayName(model: string): Row | null {
  const parts = tokenize(model);
  if (parts.length < 2) return null;
  const matches = labNames.filter(item => item.tokens.length >= parts.length
    && item.provider.length && item.provider.every((token, i) => parts[i] === token)
    && parts.every((part, i) => item.tokens[i] === part));
  const rows = new Map(matches.map(item => [`${item.row.provider}/${item.row.model}`, item.row]));
  return rows.size === 1 ? [...rows.values()][0] : null;
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
  if (!row) row = chooseByDisplayName(parts[parts.length - 1]);
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
