// Explicit maintainer import of the public models.dev API. The plugin never
// fetches it in the background or reads a gateway's settings/credentials.
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/import-public-prices.mjs <models.dev api.json>');
const bytes = await readFile(input);
const api = JSON.parse(bytes.toString('utf8'));
const rows = [];
let unsupported = 0;
const prices = cost => {
  const result = {};
  for (const [source, target] of [['input', 'inputTokens'], ['output', 'outputTokens'], ['cache_read', 'cacheReadTokens'], ['cache_write_5m', 'cacheWrite5mTokens'], ['cache_write_1h', 'cacheWrite1hTokens']]) {
    const n = cost?.[source];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) result[target] = n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 });
  }
  return result;
};
for (const [provider, info] of Object.entries(api)) {
  for (const [model, value] of Object.entries(info.models ?? {})) {
    const rates = prices(value.cost);
    if (rates.inputTokens === undefined || rates.outputTokens === undefined) continue;
    const tiers = value.cost?.tiers ?? [];
    if (!Array.isArray(tiers) || tiers.some(t => t.tier?.type !== 'context' || !Number.isSafeInteger(t.tier.size) || t.tier.size <= 0)) { unsupported++; continue; }
    const rules = tiers.map((t, index) => ({ id: `context-${index}`, when: { promptTokensAbove: t.tier.size }, mode: 'whole-request', prices: prices(t) }));
    // Older API entries provide the same legacy condition without tiers.
    if (!tiers.length && value.cost?.context_over_200k) rules.push({ id: 'context-200k', when: { promptTokensAbove: 200_000 }, mode: 'whole-request', prices: prices(value.cost.context_over_200k) });
    rows.push({ provider, model, prices: rates, ...(rules.length ? { rules } : {}) });
  }
}
rows.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`, 'en'));
const retrievedAt = new Date().toISOString();
const data = { source: 'https://models.dev/api.json', license: 'MIT', retrievedAt, version: `models.dev-${retrievedAt.slice(0, 10)}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`, rows };
await writeFile(new URL('../data/models-dev-prices.json', import.meta.url), JSON.stringify(data) + '\n');
console.log(JSON.stringify({ rows: rows.length, unsupportedTierModels: unsupported, version: data.version, retrievedAt }));
