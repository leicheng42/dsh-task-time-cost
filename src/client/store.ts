import type { EstimatorRemote, EstimatorView, RetainedTimeForecast } from '../shared/wire.ts';
import { isLive, isTerminal } from './format.ts';
import { errorInfo, requestRemote } from './remote.ts';
import type { ClientError } from './remote.ts';

export interface SnapshotState {
  view: EstimatorView | null;
  pending: boolean;
  error: ClientError | null;
  receivedAt: number;
  lastForecast: RetainedTimeForecast | null;
}
interface Entry {
  sessionId: string;
  turn: number | null;
  state: SnapshotState;
  listeners: Set<() => void>;
  inFlight: Promise<void> | null;
  controller: AbortController | null;
  poll: ReturnType<typeof setTimeout> | null;
  projectionRevision: number | undefined;
  dirty: boolean;
  generation: number;
  fetched: boolean;
}

/** A single clock for every live row. It never calls the remote service. */
export class LocalClock {
  private now = Date.now();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private intervalMs = 1_000;
  getSnapshot = () => this.now;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.timer) this.start();
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  };
  private start() {
    this.now = Date.now();
    this.timer = setInterval(() => {
      this.now = Date.now();
      for (const listener of this.listeners) listener();
    }, this.intervalMs);
  }
  private stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  configure(intervalMs: number) {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    this.intervalMs = Math.max(250, intervalMs);
    if (this.timer) { this.stop(); this.start(); }
  }
  dispose() { this.stop(); this.listeners.clear(); }
}

/** Shared by both slots; each session/turn has at most one request and one polling timer. */
export class SnapshotStore {
  readonly clock = new LocalClock();
  private entries = new Map<string, Entry>();
  private refreshMs = 5_000;
  private disposed = false;
  private readonly remote: EstimatorRemote;
  constructor(remote: EstimatorRemote) { this.remote = remote; }

  private entry(sessionId: string, turn: number | null): Entry {
    const key = JSON.stringify([sessionId, turn]);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        sessionId, turn, state: { view: null, pending: false, error: null, receivedAt: 0, lastForecast: null },
        listeners: new Set(), inFlight: null, controller: null, poll: null,
        projectionRevision: undefined, dirty: false, generation: 0, fetched: false,
      };
      this.entries.set(key, entry);
    }
    return entry;
  }
  getSnapshot = (sessionId: string, turn: number | null): SnapshotState => this.entry(sessionId, turn).state;

  subscribe = (sessionId: string, turn: number | null, listener: () => void) => {
    const entry = this.entry(sessionId, turn);
    entry.listeners.add(listener);
    if (!entry.fetched) void this.refresh(sessionId, turn);
    else this.schedulePoll(entry);
    return () => {
      entry.listeners.delete(listener);
      if (!entry.listeners.size) {
        this.clearPoll(entry);
        entry.dirty = false;
        if (entry.inFlight) {
          entry.generation++;
          entry.controller?.abort();
          entry.controller = null;
          entry.inFlight = null;
          entry.fetched = false;
          entry.state = { ...entry.state, pending: false };
        }
      }
    };
  };

  /** Event-driven refresh also catches a turn that starts and finishes between polling ticks. */
  projectionChanged(sessionId: string, turn: number | null, revision: number | undefined) {
    if (this.disposed || revision === undefined) return;
    const entry = this.entry(sessionId, turn);
    if (entry.projectionRevision === revision) return;
    const first = entry.projectionRevision === undefined;
    entry.projectionRevision = revision;
    if (entry.inFlight) {
      if (!first) entry.dirty = true;
      return;
    }
    void this.refresh(sessionId, turn);
  }

  refresh = (sessionId: string, turn: number | null): Promise<void> => {
    if (this.disposed) return Promise.resolve();
    const entry = this.entry(sessionId, turn);
    if (entry.inFlight) return entry.inFlight;
    this.clearPoll(entry);
    const generation = ++entry.generation;
    const controller = new AbortController();
    entry.controller = controller;
    entry.dirty = false;
    entry.state = { ...entry.state, pending: true, error: null };
    this.emit(entry);
    entry.inFlight = (async () => {
      try {
        const view = await requestRemote((signal) => this.remote.snapshot(sessionId, turn, signal), controller.signal);
        if (this.disposed || generation !== entry.generation) return;
        entry.fetched = true;
        const snapshot = view.snapshot;
        const previous = snapshot ? [view.lastForecast, entry.state.lastForecast]
          .filter((value): value is RetainedTimeForecast => !!value && value.taskKey === snapshot.taskKey)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null : entry.state.lastForecast;
        const lastForecast = snapshot && isTerminal(snapshot.state) ? null
          : snapshot?.remainingMs && snapshot.remainingMs.high > 0 ? { taskKey: snapshot.taskKey,
            remainingMs: { ...snapshot.remainingMs }, estimatedTotalMs: snapshot.estimatedTotalMs ? { ...snapshot.estimatedTotalMs } : null, updatedAt: snapshot.updatedAt }
          : previous;
        entry.state = {
          view, pending: false, receivedAt: Date.now(), lastForecast,
          error: view.error ? { code: 'ESTIMATE', message: view.error } : null,
        };
      } catch (error) {
        if (this.disposed || generation !== entry.generation) return;
        entry.fetched = true;
        entry.state = { ...entry.state, pending: false, error: errorInfo(error) };
      } finally {
        if (generation === entry.generation && !this.disposed) {
          entry.inFlight = null;
          entry.controller = null;
          this.emit(entry);
          if (entry.dirty && entry.listeners.size) void this.refresh(sessionId, turn);
          else this.schedulePoll(entry);
        }
      }
    })();
    return entry.inFlight;
  };

  configure(config: Record<string, unknown>) {
    const refresh = config.predictionRefreshMs;
    if (typeof refresh === 'number' && Number.isFinite(refresh) && refresh > 0) this.refreshMs = Math.max(250, refresh);
    const timer = config.timerRefreshMs;
    if (typeof timer === 'number') this.clock.configure(timer);
    for (const entry of this.entries.values()) {
      this.clearPoll(entry);
      this.schedulePoll(entry);
    }
  }

  invalidate() {
    for (const entry of this.entries.values()) {
      if (!entry.listeners.size) { entry.fetched = false; continue; }
      if (entry.inFlight) entry.dirty = true;
      else void this.refresh(entry.sessionId, entry.turn);
    }
  }

  private emit(entry: Entry) { for (const listener of entry.listeners) listener(); }
  private clearPoll(entry: Entry) {
    if (entry.poll !== null) clearTimeout(entry.poll);
    entry.poll = null;
  }
  private schedulePoll(entry: Entry) {
    if (this.disposed || entry.poll || entry.inFlight || !entry.listeners.size) return;
    const snapshot = entry.state.view?.snapshot;
    if (!snapshot || !isLive(snapshot.state)) return;
    entry.poll = setTimeout(() => {
      entry.poll = null;
      void this.refresh(entry.sessionId, entry.turn);
    }, this.refreshMs);
  }
  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.clearPoll(entry);
      entry.generation++;
      entry.controller?.abort();
      entry.listeners.clear();
    }
    this.entries.clear();
    this.clock.dispose();
  }
}
