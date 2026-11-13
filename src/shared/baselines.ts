import type { RequestMode, RouteApplicability, SourceMetadata, TaskKind } from './types.ts';
import { assertSpan } from './types.ts';

export const BASELINE_METRICS = ['requestCount', 'visibleOutputTokens', 'toolMs', 'firstContentMs', 'firstTextMs', 'visibleTps', 'totalCallMs', 'inputTokens'] as const;
export type BaselineMetric = typeof BASELINE_METRICS[number];
export type MetricValue = { low: number; high: number } | { mean: number } | { value: number } | { p50: number; p90?: number; p95?: number };
export interface BaselineRecord extends SourceMetadata {
  seedId: string;
  taskKind: TaskKind;
  appliesTo: RouteApplicability;
  metrics: Partial<Record<BaselineMetric, MetricValue>>;
}
const TASK_KINDS = ['question', 'writing', 'file-analysis', 'code', 'research', 'unknown'];
const ROUTE_FIELDS = ['providerId', 'endpointFingerprint', 'modelId', 'requestMode', 'reasoningEffort', 'serviceTier', 'inputBucket', 'cacheBucket', 'concurrencyBucket'] as const;
const MODES: RequestMode[] = ['text', 'tool', 'mixed', 'unknown', 'non-streaming'];

export function validateBaselines(records: BaselineRecord[]): void {
  if (!Array.isArray(records)) throw new TypeError('Baseline records must be an array');
  const keys = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object') throw new TypeError('Invalid baseline record');
    const key = JSON.stringify([record.seedId, record.dataVersion]);
    if (!record.seedId || !record.dataVersion || keys.has(key)) throw new TypeError('Duplicate or missing baseline seed/version');
    keys.add(key);
    if (!TASK_KINDS.includes(record.taskKind) || !['heuristic', 'local-measured', 'public-measured'].includes(record.sourceKind)) throw new TypeError('Invalid baseline kind/source');
    if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(record.date) || !Number.isFinite(Date.parse(record.date))) throw new TypeError('Baseline date must be ISO');
    if (!record.scope || !record.timingBasis || !['assumption-range', 'mean', 'sample', 'quantiles'].includes(record.statistic)) throw new TypeError('Missing baseline scope/statistic/timing basis');
    if (record.sampleCount !== null && (!Number.isSafeInteger(record.sampleCount) || record.sampleCount < 1)) throw new TypeError('Sample count must be positive or null');
    if (record.sourceKind === 'heuristic' && (record.sampleCount !== null || record.statistic !== 'assumption-range')) throw new TypeError('Heuristic assumptions must not claim measured samples/quantiles');
    if (record.statistic === 'quantiles' && record.sampleCount === null) throw new TypeError('Quantiles require a supported sample count');
    if (record.statistic === 'sample' && record.sampleCount !== 1) throw new TypeError('A single sample must declare sampleCount=1');
    if (record.sourceUrl !== null) {
      const url = new URL(record.sourceUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new TypeError('Invalid source URL');
    }
    if (record.sourceKind === 'public-measured' && !record.sourceUrl) throw new TypeError('A public measurement requires its source URL');
    if (!record.appliesTo || typeof record.appliesTo !== 'object' || Array.isArray(record.appliesTo)) throw new TypeError('Missing baseline applicability');
    for (const [field, value] of Object.entries(record.appliesTo)) {
      if (!ROUTE_FIELDS.includes(field as typeof ROUTE_FIELDS[number]) || typeof value !== 'string' || !value) throw new TypeError('Invalid baseline route field');
      if (field === 'requestMode' && value !== '*' && !MODES.includes(value as RequestMode)) throw new TypeError('Invalid baseline mode');
    }
    if (!record.metrics || typeof record.metrics !== 'object' || Array.isArray(record.metrics) || !Object.keys(record.metrics).length) throw new TypeError('No baseline metrics');
    for (const [name, metric] of Object.entries(record.metrics)) {
      if (!BASELINE_METRICS.includes(name as BaselineMetric) || !metric || typeof metric !== 'object') throw new TypeError('Invalid baseline metric');
      for (const value of Object.values(metric)) if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError('Metrics must be finite and nonnegative');
      const fields = Object.keys(metric).sort().join(',');
      if (record.statistic === 'assumption-range') {
        if (fields !== 'high,low') throw new TypeError('An assumption must provide a range');
        assertSpan(metric as { low: number; high: number }, name);
      } else if (record.statistic === 'mean') {
        if (fields !== 'mean') throw new TypeError('A mean must not fabricate a range/quantiles');
      } else if (record.statistic === 'sample') {
        if (fields !== 'value') throw new TypeError('A sample must report its original value');
      } else {
        const q = metric as { p50: number; p90?: number; p95?: number };
        if (!('p50' in q) || Object.keys(metric).some(field => !['p50', 'p90', 'p95'].includes(field)) || (q.p90 !== undefined && q.p90 < q.p50) || (q.p95 !== undefined && q.p95 < (q.p90 ?? q.p50))) throw new TypeError('Invalid supported quantiles');
      }
    }
  }
}

/** Import is atomic: invalid content throws and leaves previous records untouched. */
export function importBaselines(text: string, format: 'json' | 'csv', previous: BaselineRecord[] = []): { records: BaselineRecord[]; imported: number; diagnostics: string[] } {
  let incoming: BaselineRecord[];
  if (format === 'json') {
    const decoded = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (Array.isArray(decoded)) incoming = decoded;
    else {
      if (decoded?.schemaVersion !== 1 || !Array.isArray(decoded.records)) throw new TypeError('Unsupported baseline document');
      incoming = decoded.records;
    }
  } else if (format === 'csv') incoming = csvBaselines(text);
  else throw new TypeError('Unsupported baseline format');
  validateBaselines(previous);
  validateBaselines(incoming);
  const merged = new Map(previous.map(record => [JSON.stringify([record.seedId, record.dataVersion]), structuredClone(record)]));
  for (const record of incoming) merged.set(JSON.stringify([record.seedId, record.dataVersion]), structuredClone(record));
  return { records: [...merged.values()], imported: incoming.length, diagnostics: [] };
}

export function parseCsv(text: string): string[][] {
  text = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  let closedQuote = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closedQuote = true; }
      } else value += character;
      continue;
    }
    if (closedQuote && ![',', '\r', '\n'].includes(character)) throw new TypeError('Unexpected content after a CSV quote');
    if (character === '"') {
      if (value) throw new TypeError('Unexpected quote in CSV field');
      quoted = true;
    } else if (character === ',') { row.push(value); value = ''; closedQuote = false; }
    else if (character === '\r' || character === '\n') {
      if (character === '\r' && text[index + 1] === '\n') index++;
      row.push(value);
      if (row.some(cell => cell.length)) rows.push(row);
      row = []; value = ''; closedQuote = false;
    } else value += character;
  }
  if (quoted) throw new TypeError('Unclosed CSV quote');
  if (value || row.length || closedQuote) { row.push(value); if (row.some(cell => cell.length)) rows.push(row); }
  return rows;
}

function csvBaselines(text: string): BaselineRecord[] {
  const [headers, ...rows] = parseCsv(text);
  if (!headers || new Set(headers).size !== headers.length) throw new TypeError('Missing/duplicate CSV headers');
  const metadata = ['seedId', 'taskKind', 'date', 'sourceUrl', 'dataVersion', 'timingBasis', 'statistic', 'sampleCount', 'scope', 'sourceKind'];
  const metricColumns = BASELINE_METRICS.flatMap(metric => ['low', 'high', 'mean', 'value', 'p50', 'p90', 'p95'].map(field => `${metric}.${field}`));
  if (headers.some(header => !metadata.includes(header) && !ROUTE_FIELDS.includes(header as typeof ROUTE_FIELDS[number]) && !metricColumns.includes(header))) throw new TypeError('Unknown CSV column');
  for (const required of metadata) if (!headers.includes(required)) throw new TypeError(`Missing CSV column: ${required}`);
  return rows.map(cells => {
    if (cells.length !== headers.length) throw new TypeError('CSV row width mismatch');
    const fields = Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
    const appliesTo: Record<string, string> = {};
    for (const route of ROUTE_FIELDS) if (fields[route]) appliesTo[route] = fields[route];
    const metrics: Record<string, Record<string, number>> = {};
    for (const column of metricColumns) {
      if (fields[column] === undefined || fields[column] === '') continue;
      const [metric, name] = column.split('.');
      metrics[metric] ??= {};
      metrics[metric][name] = Number(fields[column]);
    }
    return { ...Object.fromEntries(metadata.map(key => [key, fields[key]])), sourceUrl: fields.sourceUrl || null, sampleCount: fields.sampleCount === '' ? null : Number(fields.sampleCount), appliesTo, metrics } as unknown as BaselineRecord;
  });
}
