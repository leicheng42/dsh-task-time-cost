import assert from 'node:assert/strict';
import test from 'node:test';
import type { EstimatorRemote, ManagementResult, RemoteResult } from '../../src/shared/wire.ts';
import { errorInfo, errorText, manageRemote, RemoteCallError, requestRemote, unwrapRemote } from '../../src/client/remote.ts';
import { snapshotSchema } from '../../src/shared/remote-contract.ts';
import { snapshot, translator } from './fixtures.ts';

const failure = { ok: false, error: { code: 'DENIED', message: 'Host refused this action' } } as const;
function remoteWith(result: RemoteResult<ManagementResult>): EstimatorRemote {
  return { snapshot: async () => ({ ok: true, value: { available: true, snapshot: null, error: null } }), manage: async () => result };
}

test('RemoteResult errors retain Host code and message', () => {
  assert.throws(() => unwrapRemote(failure), (error: unknown) => error instanceof RemoteCallError && error.code === 'DENIED' && error.message === failure.error.message);
  assert.deepEqual(unwrapRemote({ ok: true, value: { n: 1 } }), { n: 1 });
});

test('management handles both remote failure and business failure without swallowing either', async () => {
  await assert.rejects(manageRemote(remoteWith(failure), 'saveConfig', '{}'), (error: unknown) => error instanceof RemoteCallError && error.code === 'DENIED');
  await assert.rejects(manageRemote(remoteWith({ ok: true, value: { ok: false, message: 'Invalid configuration' } }), 'saveConfig', '{}'), /Invalid configuration/);
  assert.equal((await manageRemote(remoteWith({ ok: true, value: { ok: true, message: 'saved' } }), 'saveConfig', '{}')).ok, true);
});

test('management passes JSON/CSV content and empty read/reset/export payloads unchanged', async () => {
  const calls: Array<[string, string]> = [];
  const remote: EstimatorRemote = { ...remoteWith({ ok: true, value: { ok: true, message: 'ok' } }), manage: async (action, payload) => { calls.push([action, payload]); return { ok: true, value: { ok: true, message: 'ok' } }; } };
  const csv = 'model,firstTextMs\nexample-model,1234\n';
  await manageRemote(remote, 'importBaselines', csv);
  await manageRemote(remote, 'saveConfig', '{"performanceAlpha":0.2}');
  for (const action of ['read', 'resetCalibration', 'export'] as const) await manageRemote(remote, action, '');
  assert.deepEqual(calls, [['importBaselines', csv], ['saveConfig', '{"performanceAlpha":0.2}'], ['read', ''], ['resetCalibration', ''], ['export', '']]);
});

test('transport exceptions are preserved and slow calls are bounded and aborted', async () => {
  await assert.rejects(requestRemote(async () => { throw new Error('connection lost'); }), /connection lost/);
  let signal: AbortSignal | undefined;
  await assert.rejects(requestRemote((abort) => { signal = abort; return new Promise<RemoteResult<never>>(() => {}); }, undefined, 10), (error: unknown) => error instanceof RemoteCallError && error.code === 'TIMEOUT');
  assert.equal(signal?.aborted, true);
});

test('localized error text retains an empty-message failure code and explains timeouts', () => {
  const t = translator();
  assert.equal(errorText({ code: 'EXPORT_EMPTY', message: '' }, t), 'Operation failed (EXPORT_EMPTY)');
  assert.equal(errorText({ code: 'TIMEOUT', message: '' }, t), 'The Host did not respond in time. Retry the request.');
});

test('disposing a parent request aborts the in-flight remote call', async () => {
  const parent = new AbortController();
  let signal: AbortSignal | undefined;
  const promise = requestRemote((abort) => { signal = abort; return new Promise<RemoteResult<never>>(() => {}); }, parent.signal);
  parent.abort();
  await assert.rejects(promise, (error: unknown) => error instanceof RemoteCallError && error.code === 'ABORTED');
  assert.equal(signal?.aborted, true);
  assert.deepEqual(errorInfo(new Error('unexpected transport failure')), { code: 'Error', message: 'unexpected transport failure' });
});

test('Remote snapshot codec preserves session totals separately from the current turn', () => {
  const original = snapshot({ sessionElapsedMs: 91_000, sessionRemainingMs: { low: 12_000, high: 24_000 }, sessionTurns: 3, remainingTypicalMs: 16_000, workloadScale: 'program', forecastScope: 'whole_goal' });
  const decoded = snapshotSchema.parse(JSON.parse(JSON.stringify(original)));
  assert.equal(decoded.remainingTypicalMs, 16_000, 'The real wire codec must retain the central reference');
  assert.equal(decoded.workloadScale, 'program');
  assert.equal(decoded.forecastScope, 'whole_goal');
  assert.equal(decoded.sessionElapsedMs, 91_000);
  assert.deepEqual(decoded.sessionRemainingMs, { low: 12_000, high: 24_000 });
  assert.equal(decoded.sessionTurns, 3);
  assert.equal(decoded.elapsedActiveMs, 1_000);
  assert.equal(decoded.scope, 'current_turn');
  assert.equal(snapshotSchema.parse(snapshot()).sessionTurns, undefined);
  assert.equal(snapshotSchema.parse(snapshot({ sessionRemainingMs: null })).sessionRemainingMs, null);
  assert.throws(() => snapshotSchema.parse(snapshot({ sessionTurns: 1.5 })));
});
