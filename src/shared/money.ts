/** Decimal fixed point. Monetary totals use 24 decimal places, never binary floats. */
export const MONEY_DECIMALS = 24;
export const RATE_DECIMALS = 12;
export const MONEY_SCALE = 10n ** BigInt(MONEY_DECIMALS);

export function parseFixed(value: string, decimals: number): bigint {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) throw new TypeError(`Invalid nonnegative decimal: ${String(value)}`);
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > decimals && /[1-9]/.test(fraction.slice(decimals))) throw new TypeError(`Decimal exceeds ${decimals} places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.slice(0, decimals).padEnd(decimals, '0') || '0');
}

export function formatFixed(value: bigint, decimals = MONEY_DECIMALS): string {
  const sign = value < 0 ? '-' : '';
  const absolute = value < 0 ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${sign}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}

export function tokenCost(tokens: number, pricePerMillion: string): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError('Tokens must be nonnegative safe integers');
  return BigInt(tokens) * parseFixed(pricePerMillion, RATE_DECIMALS) * (10n ** BigInt(MONEY_DECIMALS - RATE_DECIMALS - 6));
}

export function multiplyMoney(amount: bigint, multiplier: string): bigint {
  const scale = 10n ** BigInt(RATE_DECIMALS);
  const product = amount * parseFixed(multiplier, RATE_DECIMALS);
  // Rounds only below the 24th currency decimal place.
  return (product + scale / 2n) / scale;
}

export function addMoneyStrings(a: string, b: string): string {
  return formatFixed(parseFixed(a, MONEY_DECIMALS) + parseFixed(b, MONEY_DECIMALS));
}

export function roundMoney(amount: string, decimals = 2): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > MONEY_DECIMALS) throw new TypeError('Invalid display precision');
  const value = parseFixed(amount, MONEY_DECIMALS);
  const step = 10n ** BigInt(MONEY_DECIMALS - decimals);
  const rounded = (value + step / 2n) / step;
  const formatted = formatFixed(rounded, decimals);
  if (decimals === 0) return formatted;
  const [whole, fraction = ''] = formatted.split('.');
  return `${whole}.${fraction.padEnd(decimals, '0')}`;
}
