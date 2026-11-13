import { z } from 'zod';
import { createHash } from 'node:crypto';
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
import type { Domain, DomainFacility, DomainGlobalSpec, DomainTableSpec } from '@deepseek-ai/dsh-storage-domain';
import type { CallFact } from './facts.ts';
import type { RouteIdentity } from '../shared/types.ts';
import type { CallObservation } from '../shared/performance.ts';
import type { NormalizedUsage } from '../shared/usage.ts';
import type { CallCost, PriceResolution } from '../shared/pricing.ts';
import type { EstimateSnapshot, RetainedTimeForecast } from '../shared/wire.ts';
import { snapshotSchema, retainedTimeForecastSchema } from '../shared/remote-contract.ts';
import { callRecordSchema } from './record-schema.ts';
import type { PluginConfig } from './config.ts';

export interface CallRecord {
  id: string; savedAt: number; fact: CallFact; route: RouteIdentity;
  usage: NormalizedUsage; cost: CallCost; resolution: PriceResolution;
  observation: CallObservation | null;
}
export interface TaskRecord {
  id: string; savedAt: number; current: EstimateSnapshot; sourceRevision?: number;
  revisions: EstimateSnapshot[];
  lastForecast?: RetainedTimeForecast | null;
  learned: { calls: number; visibleOutputTokens: number; toolWorkMs: number; eligible: boolean } | null;
}
export interface Diagnostic { time: number; code: string; message: string }
const globalSchema = z.object({
  config: z.record(z.string(), z.json()).nullable(),
  resetAt: z.number().finite().nonnegative(),
  baselineImport: z.string().max(2_000_000).nullable(),
}).strict();
const taskSchema = z.object({ id: z.string(), savedAt: z.number().finite().nonnegative(), current: snapshotSchema, sourceRevision: z.number().int().nonnegative().optional(),
  revisions: z.array(snapshotSchema).max(128), lastForecast: retainedTimeForecastSchema.nullable().optional(), learned: z.object({ calls: z.number().int().nonnegative(), visibleOutputTokens: z.number().nonnegative(), toolWorkMs: z.number().nonnegative(), eligible: z.boolean() }).nullable() });
interface GlobalState { config: Record<string, JsonValue> | null; resetAt: number; baselineImport: string | null }
interface RepositorySpec {
  name: string; version: number; layout: 'per-record'; invalidRecords: 'backup-and-skip';
  global: DomainGlobalSpec<GlobalState>;
  tables: { calls: DomainTableSpec<string, CallRecord>; tasks: DomainTableSpec<string, TaskRecord> };
}
// Widen Zod builders to their public value contracts before Domain's conditional types.
// Retaining every builder generic here causes needless recursive schema expansion in tsc.
const spec: RepositorySpec = { name: 'dsh_task_time_cost', version: 1, layout: 'per-record' as const,
  invalidRecords: 'backup-and-skip' as const,
  global: { schema: globalSchema, initial: { config: null, resetAt: 0, baselineImport: null } },
  tables: { calls: { valueSchema: callRecordSchema }, tasks: { valueSchema: taskSchema } },
};
type Store = Domain<typeof spec>;
// Canonical session:sequence identities are values. Backend keys are safe on Windows and POSIX.
const storageKey = (id: string): string => createHash('sha256').update(id, 'utf8').digest('hex');

export class Repository {
  private store: Store | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  readonly calls = new Map<string, CallRecord>();
  readonly tasks = new Map<string, TaskRecord>();
  readonly diagnostics: Diagnostic[] = [];
  error: string | null = null;
  resetAt = 0;
  savedConfig: Record<string, unknown> | null = null;
  baselineImport: string | null = null;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  constructor(log: (message: string) => void, now = () => Date.now()) { this.log = log; this.now = now; }

  async open(facility: DomainFacility): Promise<void> {
    try {
      this.store = await facility.open(spec);
      const global = this.store.global.get();
      this.resetAt = global.resetAt;
      this.savedConfig = global.config;
      this.baselineImport = global.baselineImport;
      for (const [, record] of this.store.table('calls').entries()) this.calls.set(record.id, record);
      for (const [, record] of this.store.table('tasks').entries()) this.tasks.set(record.id, record);
    } catch (error) { this.fail('storage-open', error); }
  }
  get available(): boolean { return this.store !== null && this.error === null && !this.closed; }
  diagnose(code: string, message: string): void {
    // Only package-owned error codes and safe explanations enter persisted/exportable diagnostics.
    this.diagnostics.push({ time: this.now(), code, message });
    this.diagnostics.splice(0, Math.max(0, this.diagnostics.length - 100));
    this.log(`[${code}] ${message}`);
  }
  fail(code: string, error: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    // Error details can contain provider URLs/arguments; the export gets only the operation code.
    this.error ??= `Estimator unavailable (${code}). Check the DSH plugin log.`;
    this.diagnose(code, this.error);
    this.log(detail);
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    if (!this.available) return Promise.resolve();
    const pending = this.queue.then(async () => { if (this.available) await operation(); });
    this.queue = pending.catch(error => this.fail('storage-write', error));
    return this.queue;
  }
  saveCall(record: CallRecord): Promise<void> {
    const existing = this.calls.get(record.id);
    if (existing) return Promise.resolve();
    const validated = callRecordSchema.safeParse(record);
    if (!validated.success) { this.fail('invalid-call-record', new Error('Invalid call metadata; the record was not persisted.')); return Promise.resolve(); }
    record = validated.data;
    this.calls.set(record.id, structuredClone(record));
    return this.enqueue(async () => {
      if (!this.store) throw new Error('Storage is not mounted');
      await this.store.table('calls').put(storageKey(record.id), record);
    });
  }
  /**
   * Overwrite a derived record. Normalization and pricing are derivations of the
   * adapter's own facts, so a corrected rule must be able to heal stored bytes
   * instead of leaving two incompatible readings of the same call on disk.
   */
  replaceCall(record: CallRecord): Promise<void> {
    const validated = callRecordSchema.safeParse(record);
    if (!validated.success) { this.fail('invalid-call-record', new Error('Invalid call metadata; the healed record was not persisted.')); return Promise.resolve(); }
    const healed = validated.data;
    this.calls.set(healed.id, structuredClone(healed));
    return this.enqueue(async () => {
      if (!this.store) throw new Error('Storage is not mounted');
      await this.store.table('calls').put(storageKey(healed.id), healed);
    });
  }
  saveTask(record: TaskRecord): Promise<void> {
    this.tasks.set(record.id, structuredClone(record));
    return this.enqueue(async () => {
      if (!this.store) throw new Error('Storage is not mounted');
      await this.store.table('tasks').put(storageKey(record.id), record);
    });
  }
  saveConfig(config: PluginConfig): Promise<void> {
    this.savedConfig = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    return this.enqueue(async () => { if (!this.store) throw new Error('Storage is not mounted'); await this.store.global.set({ config: this.savedConfig as Record<string, JsonValue>, resetAt: this.resetAt, baselineImport: this.baselineImport }); });
  }
  saveBaselineImport(text: string): Promise<void> {
    this.baselineImport = text;
    return this.enqueue(async () => { if (!this.store) throw new Error('Storage is not mounted'); await this.store.global.set({ config: this.savedConfig as Record<string, JsonValue> | null, resetAt: this.resetAt, baselineImport: text }); });
  }
  resetCalibration(): Promise<void> {
    this.resetAt = this.now();
    return this.enqueue(async () => {
      if (!this.store) throw new Error('Storage is not mounted');
      // Retain usage, resolved prices and task history. resetAt excludes older learning only.
      await this.store.global.set({ config: this.savedConfig as Record<string, JsonValue> | null, resetAt: this.resetAt, baselineImport: this.baselineImport });
    });
  }
  async prune(config: PluginConfig): Promise<void> {
    const cutoff = this.now() - config.historyRetentionDays * 86_400_000;
    const calls = [...this.calls.values()].sort((a, b) => b.savedAt - a.savedAt);
    const buckets = new Map<string, number>();
    const expiredCalls: string[] = [];
    for (const call of calls) {
      const key = JSON.stringify(call.route);
      const count = (buckets.get(key) ?? 0) + 1; buckets.set(key, count);
      if (call.savedAt < cutoff || count > config.maxSamplesPerBucket || buckets.size > 2000) { expiredCalls.push(call.id); this.calls.delete(call.id); }
    }
    const expiredTasks = [...this.tasks.values()].sort((a, b) => b.savedAt - a.savedAt).filter((task, index) => (task.savedAt < cutoff || index >= 2000) && !['running', 'waiting_user', 'queued'].includes(task.current.state)).map(task => task.id);
    for (const id of expiredTasks) this.tasks.delete(id);
    if (!expiredCalls.length && !expiredTasks.length) return;
    await this.enqueue(async () => { if (!this.store) return; await this.store.table('calls').deleteMany(expiredCalls.map(storageKey)); await this.store.table('tasks').deleteMany(expiredTasks.map(storageKey)); });
  }
  async flush(): Promise<void> { await this.queue; }
  async close(): Promise<void> {
    await this.flush(); this.closed = true;
    await this.store?.close(); this.store = null;
  }
}
