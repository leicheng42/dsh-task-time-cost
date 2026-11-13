import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigSaveError, ownerEntry, persistConfig } from '../../src/host/config-entry.ts';
import type { ConfigEditorLike, ConfigEntryLike } from '../../src/host/config-entry.ts';

const estimator = (config: Record<string, unknown> = {}, active = true): ConfigEntryLike => ({
  options: { id: 'task-time-cost', name: 'dsh-task-time-cost', config },
  ...(active ? { fiber: { state: 2 } } : {}),
});

function editorWith(entries: ConfigEntryLike[], adopt: (entry: ConfigEntryLike, next: Record<string, unknown>) => void) {
  const calls: ConfigEntryLike[] = [];
  const editor: ConfigEditorLike = {
    entries: () => entries,
    async edit(entry, change) {
      const target = entry as ConfigEntryLike;
      calls.push(target);
      adopt(target, change(target.options.config as Record<string, unknown> ?? {}, {}));
    },
  };
  return { editor, calls };
}

test('config-entry: a foreign ambient entry is never the configuration target', async () => {
  const gateway: ConfigEntryLike = { options: { id: 'typert-gateway', name: '@deepseek-ai/dsh-api-gateway', config: {} } };
  const mine = estimator({ predictionRefreshMs: 5000 });
  const { editor, calls } = editorWith([gateway, mine], (entry, next) => { entry.options.config = next; });
  assert.equal(ownerEntry(editor, gateway), mine);
  await persistConfig(editor, gateway, { predictionRefreshMs: 6000 }, () => ({ predictionRefreshMs: 6000 }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0], mine, 'the gateway entry must not receive estimator configuration');
  assert.equal((gateway.options.config as Record<string, unknown>).predictionRefreshMs, undefined);
  assert.equal((mine.options.config as Record<string, unknown>).predictionRefreshMs, 6000);
});

test('config-entry: an ambient entry that is not ours falls back to the active owned entry', () => {
  const stale = estimator({}, false);
  const active = estimator({ predictionRefreshMs: 5000 });
  const { editor } = editorWith([stale, active], () => {});
  assert.equal(ownerEntry(editor, stale), active);
});

test('config-entry: a write the running entry did not adopt is a failure, not a success', async () => {
  const mine = estimator({ predictionRefreshMs: 5000 });
  const { editor } = editorWith([mine], () => { /* the file write is ignored by the running entry */ });
  await assert.rejects(
    persistConfig(editor, mine, { predictionRefreshMs: 6000 }, () => ({ predictionRefreshMs: 5000 })),
    (error: unknown) => error instanceof ConfigSaveError && /did not adopt/.test(error.message),
  );
});

test('config-entry: missing owner and rejected readback are reported, never silently accepted', async () => {
  const empty: ConfigEditorLike = { entries: () => [], edit: async () => {} };
  assert.throws(() => ownerEntry(empty), (error: unknown) => error instanceof ConfigSaveError);
  const mine = estimator({ predictionRefreshMs: 5000 });
  const { editor } = editorWith([mine], () => { mine.options.config = { unexpected: true }; });
  await assert.rejects(persistConfig(editor, mine, { predictionRefreshMs: 6000 }, value => {
    if (!value || typeof value !== 'object' || (value as Record<string, unknown>).unexpected) throw new TypeError('invalid');
    return value as Record<string, unknown>;
  }), ConfigSaveError);
});

test('config-entry: matching readback resolves once with the full config', async () => {
  const mine = estimator({ predictionRefreshMs: 5000 });
  const next = { predictionRefreshMs: 6000, timerRefreshMs: 1000, prices: [] };
  const { editor, calls } = editorWith([mine], (entry, value) => { entry.options.config = value; });
  await persistConfig(editor, mine, next, value => value as Record<string, unknown>);
  assert.equal(calls.length, 1);
  assert.deepEqual(mine.options.config, next);
});
