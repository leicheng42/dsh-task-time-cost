import assert from 'node:assert/strict';
import test from 'node:test';
import type { EstimatorRemote, EstimatorView, RemoteResult } from '../../src/shared/wire.ts';
import { SnapshotStore } from '../../src/client/store.ts';
import { snapshot } from './fixtures.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}
function view(state: Parameters<typeof snapshot>[0] = {}): RemoteResult<EstimatorView> {
  return { ok: true, value: { available: true, error: null, snapshot: snapshot(state) } };
}
function remote(snapshotMethod: EstimatorRemote['snapshot']): EstimatorRemote {
  return { snapshot: snapshotMethod, manage: async () => ({ ok: true, value: { ok: true, message: 'ok' } }) };
}

test('dock and turn tail share one request for the same session and turn', async (t) => {
  const response = deferred<RemoteResult<EstimatorView>>();
  let calls = 0;
  const store = new SnapshotStore(remote(() => { calls++; return response.promise; }));
  t.after(() => store.dispose());
  const first = store.subscribe('s', 1, () => {});
  const second = store.subscribe('s', 1, () => {});
  const pending = store.refresh('s', 1);
  assert.equal(calls, 1);
  assert.equal(store.refresh('s', 1), pending);
  response.resolve(view({ state: 'completed' }));
  await pending;
  assert.equal(store.getSnapshot('s', 1).view?.snapshot?.state, 'completed');
  first(); second();
});

test('projection changes coalesce in flight and immediately fetch the latest short-task result', async (t) => {
  const responses = [deferred<RemoteResult<EstimatorView>>(), deferred<RemoteResult<EstimatorView>>()];
  let calls = 0;
  const store = new SnapshotStore(remote(() => responses[calls++].promise));
  t.after(() => store.dispose());
  const release = store.subscribe('s', 1, () => {});
  store.projectionChanged('s', 1, 1);
  const first = store.refresh('s', 1);
  store.projectionChanged('s', 1, 2);
  store.projectionChanged('s', 1, 2);
  assert.equal(calls, 1);
  responses[0].resolve(view());
  await first;
  assert.equal(calls, 2);
  responses[1].resolve(view({ state: 'completed', revision: 2 }));
  await store.refresh('s', 1);
  assert.equal(store.getSnapshot('s', 1).view?.snapshot?.revision, 2);
  release();
});

test('the first projection arriving after an empty initial response still triggers a fetch', async (t) => {
  let calls = 0;
  const store = new SnapshotStore(remote(async () => ++calls === 1
    ? { ok: true, value: { available: true, error: null, snapshot: null } }
    : view({ state: 'completed' })));
  t.after(() => store.dispose());
  const release = store.subscribe('s', null, () => {});
  await store.refresh('s', null);
  assert.equal(calls, 1);
  store.projectionChanged('s', null, 1);
  await store.refresh('s', null);
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot('s', null).view?.snapshot?.state, 'completed');
  release();
});

test('a failed first read after a remount retries instead of leaving a blank row', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const store = new SnapshotStore(remote(async () => {
    calls++;
    if (calls === 1) throw new Error('remote service not mounted yet');
    return view({ state: 'running' });
  }));
  t.after(() => store.dispose());
  const release = store.subscribe('s', 1, () => {});
  await store.refresh('s', 1);
  assert.equal(calls, 1);
  assert.match(store.getSnapshot('s', 1).error?.message ?? '', /not mounted/);
  t.mock.timers.tick(2_000);
  await store.refresh('s', 1);
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot('s', 1).error, null);
  assert.equal(store.getSnapshot('s', 1).view?.snapshot?.state, 'running');
  release();
});

test('an empty answer also retries a bounded number of times and then stops', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const store = new SnapshotStore(remote(async () => { calls++; return { ok: true, value: { available: true, error: null, snapshot: null } }; }));
  t.after(() => store.dispose());
  const release = store.subscribe('s', null, () => {});
  await store.refresh('s', null);
  for (let index = 0; index < 5; index++) { t.mock.timers.tick(2_000); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(calls, 3, 'two bounded retries follow the initial empty read, then polling stops');
  release();
});

test('only a live task polls at five seconds; waiting and completed states stop polling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const store = new SnapshotStore(remote(async () => { calls++; return view({ state: calls === 1 ? 'running' : 'waiting_user' }); }));
  t.after(() => store.dispose());
  const release = store.subscribe('s', 1, () => {});
  await store.refresh('s', 1);
  t.mock.timers.tick(4_999);
  assert.equal(calls, 1);
  t.mock.timers.tick(1);
  await store.refresh('s', 1);
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot('s', 1).view?.snapshot?.state, 'waiting_user');
  t.mock.timers.tick(30_000);
  assert.equal(calls, 2);
  release();
});

test('unsubscribing aborts a request and its late response cannot overwrite a new subscription', async (t) => {
  const responses = [deferred<RemoteResult<EstimatorView>>(), deferred<RemoteResult<EstimatorView>>()];
  const signals: AbortSignal[] = [];
  let calls = 0;
  const store = new SnapshotStore(remote((_session, _turn, signal) => {
    if (signal) signals.push(signal);
    return responses[calls++].promise;
  }));
  t.after(() => store.dispose());
  const first = store.subscribe('s', 1, () => {});
  first();
  assert.equal(signals[0].aborted, true);
  const second = store.subscribe('s', 1, () => {});
  const pending = store.refresh('s', 1);
  responses[1].resolve(view({ state: 'completed', revision: 9 }));
  await pending;
  responses[0].resolve(view({ revision: 1 }));
  await Promise.resolve();
  assert.equal(store.getSnapshot('s', 1).view?.snapshot?.revision, 9);
  second();
});

test('remote refusals and EstimatorView errors remain visible in shared state', async (t) => {
  let calls = 0;
  const store = new SnapshotStore(remote(async () => ++calls === 1
    ? { ok: false, error: { code: 'STORAGE', message: 'storage unavailable' } }
    : { ok: true, value: { available: false, error: 'projection unavailable', snapshot: null } }));
  t.after(() => store.dispose());
  await store.refresh('s', 1);
  assert.deepEqual(store.getSnapshot('s', 1).error, { code: 'STORAGE', message: 'storage unavailable' });
  await store.refresh('s', 1);
  assert.deepEqual(store.getSnapshot('s', 1).error, { code: 'ESTIMATE', message: 'projection unavailable' });
  assert.equal(store.getSnapshot('s', 1).pending, false);
});

test('unknown updates keep a frozen last time reference without inventing a current token or cost forecast', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  let calls = 0;
  const store = new SnapshotStore(remote(async () => ++calls === 1 ? view({ remainingTypicalMs: 12_000 }) : view({ remainingMs: null, estimatedTotalMs: null,
    estimatedTotalCost: null, estimatedTotalTokens: null, updatedAt: 2_000 })));
  t.after(() => store.dispose());
  await store.refresh('s', 1);
  await store.refresh('s', 1);
  const release = store.clock.subscribe(() => {});
  t.mock.timers.tick(90_000);
  const state = store.getSnapshot('s', 1);
  assert.deepEqual(state.lastForecast?.remainingMs, { low: 10_000, high: 20_000 }, 'Old ETA is a frozen reference, not a countdown');
  assert.equal(state.lastForecast?.updatedAt, 1_000);
  assert.equal(state.lastForecast?.remainingTypicalMs, 12_000, 'A retained central reference cannot revert to the widened interval midpoint');
  assert.equal(state.view?.snapshot?.remainingMs, null);
  assert.equal(state.view?.snapshot?.estimatedTotalTokens, null);
  assert.equal(state.view?.snapshot?.estimatedTotalCost, null);
  assert.equal(calls, 2, 'Keeping a reference starts no extra requests');
  release();
});

test('a newly mounted client can recover the same task forecast from Host history', async (t) => {
  const previous = { taskKey: 's:1', remainingMs: { low: 480_000, high: 1_800_000 }, estimatedTotalMs: null, updatedAt: 900 };
  const store = new SnapshotStore(remote(async () => ({ ok: true, value: {
    available: true, error: null, snapshot: snapshot({ remainingMs: null }), lastForecast: previous,
  } })));
  t.after(() => store.dispose());
  await store.refresh('s', 1);
  assert.deepEqual(store.getSnapshot('s', 1).lastForecast, previous);
});

test('completed tasks and a new task behind the latest-turn query cannot inherit an older ETA', async (t) => {
  for (const next of [{ state: 'completed' as const }, { taskKey: 's:2', turn: 2, remainingMs: null }]) {
    let calls = 0;
    const store = new SnapshotStore(remote(async () => ++calls === 1 ? view() : view(next)));
    t.after(() => store.dispose());
    await store.refresh('s', null);
    await store.refresh('s', null);
    assert.equal(store.getSnapshot('s', null).lastForecast, null);
  }
});

test('a fresh forecast replaces the stale reference and another task’s Host reference is ignored', async (t) => {
  let calls = 0;
  const store = new SnapshotStore(remote(async () => ++calls === 1 ? view() : view({ remainingMs: { low: 300_000, high: 600_000 }, updatedAt: 3_000 })));
  t.after(() => store.dispose());
  await store.refresh('s', 1); await store.refresh('s', 1);
  assert.deepEqual(store.getSnapshot('s', 1).lastForecast?.remainingMs, { low: 300_000, high: 600_000 });
  const other = new SnapshotStore(remote(async () => ({ ok: true, value: { available: true, error: null,
    snapshot: snapshot({ remainingMs: null }), lastForecast: { taskKey: 'other:7', remainingMs: { low: 1, high: 2 }, estimatedTotalMs: null, updatedAt: 2_000 } } })));
  t.after(() => other.dispose());
  await other.refresh('s', 1);
  assert.equal(other.getSnapshot('s', 1).lastForecast, null);
});

test('local clock ticks without issuing network calls and disposal clears its timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
  let calls = 0;
  let ticks = 0;
  const store = new SnapshotStore(remote(async () => { calls++; return view(); }));
  t.after(() => store.dispose());
  const release = store.subscribe('s', 1, () => {});
  await store.refresh('s', 1);
  const clockRelease = store.clock.subscribe(() => ticks++);
  t.mock.timers.tick(1_000);
  assert.equal(ticks, 1);
  assert.equal(store.clock.getSnapshot(), 2_000);
  assert.equal(calls, 1);
  clockRelease(); release();
  store.dispose();
  t.mock.timers.tick(30_000);
  assert.equal(ticks, 1);
  assert.equal(calls, 1);
});
