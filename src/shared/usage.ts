export const INPUT_CATEGORIES = ['inputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens', 'cacheWriteUnknownTokens'] as const;
export const BILLABLE_CATEGORIES = [...INPUT_CATEGORIES, 'outputTokens'] as const;
export type InputCategory = typeof INPUT_CATEGORIES[number];
export type BillableCategory = typeof BILLABLE_CATEGORIES[number];

/** Adapter-neutral fields. SDK-specific field names must be mapped by the Host. */
export interface RawUsage {
  inputTokens?: number | null;
  cacheReadTokens?: number | null;
  /** Total cache creation, including 1h writes; never additive to its splits. */
  cacheWriteTokens?: number | null;
  cacheWrite5mTokens?: number | null;
  cacheWrite1hTokens?: number | null;
  outputTokens?: number | null;
  reasoningTokens?: number | null;
  visibleOutputTokens?: number | null;
  totalTokens?: number | null;
}

export interface UsageSemantics {
  schema: 'dsh' | 'inclusive-input';
  outputIncludesReasoning: boolean | 'unknown';
  /** Only name fields whose source contract explicitly defines omission as zero. */
  missingMeansZero?: (keyof RawUsage)[];
  /** Null when an aggregate cache-write count has no reliable TTL semantics. */
  defaultCacheWriteTtl?: '5m' | '1h' | null;
  /**
   * Derive `outputIncludesReasoning` from arithmetic the adapter itself
   * reported when the configuration leaves it unknown. Never guesses: without
   * a matching total the answer stays unknown and the usage stays partial.
   */
  inferOutputIncludesReasoning?: boolean;
}

export interface NormalizedUsage extends Record<BillableCategory, number | null> {
  reasoningTokens: number | null;
  visibleOutputTokens: number | null;
  promptTokens: number | null;
  totalTokens: number | null;
  status: 'complete' | 'partial' | 'unknown';
  exact: boolean;
  diagnostics: string[];
}

export function normalizeUsage(raw: RawUsage, semantics: UsageSemantics): NormalizedUsage {
  if (!['dsh', 'inclusive-input'].includes(semantics.schema)) throw new TypeError('Unknown usage schema');
  if (![true, false, 'unknown'].includes(semantics.outputIncludesReasoning)) throw new TypeError('Invalid output semantics');
  const diagnostics: string[] = [];
  const invalid = new Set<string>();
  function read(key: keyof RawUsage): number | null {
    const value = raw[key];
    if (value == null) return semantics.missingMeansZero?.includes(key) ? 0 : null;
    if (!Number.isSafeInteger(value) || value < 0) {
      diagnostics.push(`invalid:${key}`);
      invalid.add(key);
      return null;
    }
    return value;
  }
  let input = read('inputTokens');
  let readTokens = read('cacheReadTokens');
  const writeTotal = read('cacheWriteTokens');
  let write5m = read('cacheWrite5mTokens');
  let write1h = read('cacheWrite1hTokens');
  let writeUnknown: number | null = null;
  const output = read('outputTokens');
  const reasoning = read('reasoningTokens');
  let visible = read('visibleOutputTokens');
  const reportedTotal = read('totalTokens');

  if (writeTotal === 0) {
    if ((write5m ?? 0) > 0 || (write1h ?? 0) > 0) {
      diagnostics.push('conflict:cache-write-total');
      write5m = write1h = writeUnknown = null;
    } else write5m = write1h = writeUnknown = 0;
  } else if (writeTotal !== null) {
    if ((write5m ?? 0) + (write1h ?? 0) > writeTotal) {
      diagnostics.push('conflict:cache-write-total');
      write5m = write1h = writeUnknown = null;
    } else if (write5m !== null && write1h !== null) {
      writeUnknown = writeTotal - write5m - write1h;
    } else if (write1h !== null && semantics.defaultCacheWriteTtl === '5m') {
      write5m = writeTotal - write1h;
      writeUnknown = 0;
    } else if (write5m !== null && semantics.defaultCacheWriteTtl === '1h') {
      write1h = writeTotal - write5m;
      writeUnknown = 0;
    } else {
      const remainder = writeTotal - (write5m ?? 0) - (write1h ?? 0);
      if (semantics.defaultCacheWriteTtl === '5m' && write5m === null && write1h === null) {
        write5m = writeTotal;
        write1h = 0;
        writeUnknown = 0;
      } else if (semantics.defaultCacheWriteTtl === '1h' && write5m === null && write1h === null) {
        write1h = writeTotal;
        write5m = 0;
        writeUnknown = 0;
      } else {
        write5m ??= 0;
        write1h ??= 0;
        writeUnknown = remainder;
      }
    }
  } else if (write5m !== null && write1h !== null) {
    // Both exhaustive TTL buckets explicitly reported by the adapter.
    writeUnknown = 0;
  }

  const cacheTotal = sumKnown([readTokens, write5m, write1h, writeUnknown]);
  if (semantics.schema === 'inclusive-input' && input !== null) {
    if (cacheTotal === null) input = null;
    else if (input < cacheTotal) {
      diagnostics.push('conflict:inclusive-input-smaller-than-cache');
      input = null;
    } else input -= cacheTotal;
  }

  let billableOutput: number | null = null;
  let outputIncludesReasoning = semantics.outputIncludesReasoning;
  if (outputIncludesReasoning === 'unknown' && semantics.inferOutputIncludesReasoning) {
    // Absent cache-write fields are not a reason to skip the check: sum what the
    // adapter reported, and let the total decide.
    const knownPrompt = [input, readTokens, write5m, write1h, writeUnknown].every(value => value === null || Number.isSafeInteger(value))
      ? [input, readTokens, write5m, write1h, writeUnknown].reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
    const inferred = inferOutputIncludesReasoning({ outputTokens: output, reasoningTokens: reasoning, totalTokens: reportedTotal }, knownPrompt);
    if (inferred !== null) { outputIncludesReasoning = inferred; diagnostics.push(`inferred:output-reasoning-${inferred ? 'inclusive' : 'exclusive'}`); }
  }
  if (outputIncludesReasoning === true) {
    billableOutput = output;
    if (output !== null && reasoning !== null) {
      if (reasoning > output) diagnostics.push('conflict:reasoning-larger-than-output');
      else if (visible === null) visible = output - reasoning;
      else if (visible + reasoning > output) diagnostics.push('conflict:visible-plus-reasoning');
    }
  } else if (outputIncludesReasoning === false) {
    billableOutput = sumKnown([output, reasoning]);
    visible ??= output;
    if (visible !== null && output !== null && visible > output) diagnostics.push('conflict:visible-larger-than-output');
  } else {
    diagnostics.push('unknown:output-reasoning-inclusion');
  }
  if (diagnostics.some(d => d.startsWith('conflict:reasoning') || d.startsWith('conflict:visible'))) billableOutput = null;

  // A reported total of exactly zero with every reported field also zero proves
  // that nothing was consumed: there is no split left to guess, so the omitted
  // cache fields are zero rather than unknown.
  const allReportedZero = reportedTotal === 0 && [input, readTokens, write5m, write1h, writeUnknown, billableOutput]
    .every(value => value === null || value === 0);
  if (allReportedZero) {
    input ??= 0; readTokens ??= 0; write5m ??= 0; write1h ??= 0; writeUnknown ??= 0; billableOutput ??= 0;
    diagnostics.push('inferred:empty-usage-report');
  }

  // The reported total exactly equalling input + output leaves no room for any
  // cache activity at all, so an omitted cache field is zero, not unknown.
  if (!allReportedZero && semantics.inferOutputIncludesReasoning && reportedTotal !== null && input !== null && billableOutput !== null
    && readTokens === null && write5m === null && write1h === null && writeUnknown === null
    && reportedTotal === input + billableOutput) {
    readTokens = 0; write5m = 0; write1h = 0; writeUnknown = 0;
    diagnostics.push('inferred:no-cache-activity');
  }

  // A reported total that no other category accounts for is the cache-write
  // remainder: the adapter omitted the field because the provider does not
  // bill the write separately, not because the price is unknown.
  if (!allReportedZero && semantics.inferOutputIncludesReasoning && reportedTotal !== null && input !== null && readTokens !== null && billableOutput !== null
    && write5m === null && write1h === null && writeUnknown === null) {
    const residual = reportedTotal - input - readTokens - billableOutput;
    if (Number.isSafeInteger(residual) && residual >= 0) { write5m = 0; write1h = 0; writeUnknown = residual; diagnostics.push('inferred:cache-write-from-total'); }
  }

  const promptTokens = sumKnown([input, readTokens, write5m, write1h, writeUnknown]);

  const calculatedTotal = sumKnown([promptTokens, billableOutput]);
  if (reportedTotal !== null && calculatedTotal !== null && reportedTotal !== calculatedTotal) diagnostics.push('conflict:totalTokens');
  const fields = [input, readTokens, write5m, write1h, writeUnknown, billableOutput];
  const complete = fields.every(value => value !== null);
  const conflict = diagnostics.some(d => d.startsWith('conflict:'));
  return {
    inputTokens: input,
    cacheReadTokens: readTokens,
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    cacheWriteUnknownTokens: writeUnknown,
    outputTokens: billableOutput,
    reasoningTokens: reasoning,
    visibleOutputTokens: visible,
    promptTokens,
    totalTokens: conflict ? null : calculatedTotal,
    status: complete && !conflict ? 'complete' : fields.some(value => value !== null) ? 'partial' : 'unknown',
    exact: complete && !conflict && invalid.size === 0,
    diagnostics,
  };
}

export function sumKnown(values: (number | null)[]): number | null {
  if (values.some(value => value === null)) return null;
  const sum = (values as number[]).reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Sum the values that were actually reported, ignoring the requests that
 * reported nothing at all.
 *
 * `sumKnown` answers "is this total exact"; this answers "how much did we
 * observe". A single adapter response without usage numbers must not erase the
 * other 400 settled requests, so the total stays a real subtotal and the caller
 * reports partial coverage instead of an unknown quantity.
 */
export function subtotalKnown(values: (number | null)[]): number | null {
  const reported = values.filter((value): value is number => value !== null);
  if (reported.length === 0) return null;
  const sum = reported.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

/**
 * Infer whether a reported output count already includes reasoning tokens.
 *
 * Uses only arithmetic the adapter itself reported: when `totalTokens` equals
 * prompt + output the output is inclusive; when it equals prompt + output +
 * reasoning the output is exclusive. Anything else is not evidence, so the
 * caller keeps its configured semantics instead of guessing.
 */
export function inferOutputIncludesReasoning(raw: RawUsage, promptTokens: number | null): boolean | null {
  const { totalTokens: total, outputTokens: output, reasoningTokens: reasoning } = raw;
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(output) || promptTokens === null) return null;
  if (promptTokens + output! === total) return true;
  if (Number.isSafeInteger(reasoning) && (reasoning as number) > 0 && promptTokens + output! + (reasoning as number) === total) return false;
  return null;
}
