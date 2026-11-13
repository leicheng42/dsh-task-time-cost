import type { NormalizedUsage } from './usage.ts';
import type { CallCost } from './pricing.ts';

export interface CallValuation { estimateVersion: string; cost: CallCost }
export interface CallRecord {
  /** Canonical attempt identity from the selected billing source, not a timestamp. */
  attemptId: string;
  source: 'dsh' | 'external';
  stage: 'live' | 'durable';
  revision: number;
  usage: NormalizedUsage;
  valuations: CallValuation[];
}
export interface CallLedger { records: Record<string, CallRecord> }

/** Durable replaces live; usage snapshots are never additive. Different sources require explicit identity correlation in the adapter. */
export function upsertCallRecord(ledger: CallLedger, incoming: CallRecord, primarySource: 'dsh' | 'external' = 'dsh'): { ledger: CallLedger; changed: boolean; reason: string } {
  if (incoming.source !== primarySource) return { ledger, changed: false, reason: 'not-primary-billing-source' };
  if (!incoming.attemptId || !Number.isSafeInteger(incoming.revision) || incoming.revision < 0) throw new TypeError('Invalid call snapshot identity/revision');
  if (!['live', 'durable'].includes(incoming.stage)) throw new TypeError('Invalid snapshot stage');
  const old = ledger.records[incoming.attemptId];
  if (old) {
    if (old.stage === 'durable' && incoming.stage === 'live') return { ledger, changed: false, reason: 'durable-already-present' };
    if (old.stage === incoming.stage && incoming.revision <= old.revision) return { ledger, changed: false, reason: 'duplicate-or-stale-snapshot' };
  }
  const copy = structuredClone(incoming);
  if (old) {
    const versions = new Set(old.valuations.map(value => value.estimateVersion));
    copy.valuations = [...structuredClone(old.valuations), ...copy.valuations.filter(value => !versions.has(value.estimateVersion))];
  }
  return { ledger: { records: { ...ledger.records, [incoming.attemptId]: copy } }, changed: true, reason: old ? 'snapshot-replaced' : 'attempt-added' };
}

/** A new price table creates a new valuation; an original historical version is immutable. */
export function appendValuation(record: CallRecord, valuation: CallValuation): CallRecord {
  if (!valuation.estimateVersion || record.valuations.some(value => value.estimateVersion === valuation.estimateVersion)) throw new TypeError('Valuation version must be new and nonempty');
  return { ...structuredClone(record), valuations: [...structuredClone(record.valuations), structuredClone(valuation)] };
}
