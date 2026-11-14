import { performance } from 'node:perf_hooks';
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';
import type { StreamStats, RouteFact } from './facts.ts';
import { emptyStreamStats, observeChunk } from './facts.ts';

export interface Clock { wall(): number; monotonic(): number }
export const systemClock: Clock = { wall: () => Date.now(), monotonic: () => performance.now() };
export interface PauseInterval { start: number; end: number }
export interface TaskRuntime {
  key: string; anchorWall: number; anchorMono: number; paused: PauseInterval[];
  pauseOwners: Set<object>; pauseStart: number | null; lastPredictionAt: number;
}
export interface LiveAttempt extends StreamStats {
  id: string; sessionId: string; turn: number; step: number; route: RouteFact;
  startedAt: number; startedMono: number; lastIndex: number;
}
export interface ToolTiming { id: string; sessionId: string; turn: number; startedAt: number; endedAt: number | null; workMs: number }

/** All process-local state has one Host owner. Clients never create observations. */
export class RuntimeObservations {
  readonly tasks = new Map<string, TaskRuntime>();
  readonly attempts = new Map<string, LiveAttempt>();
  readonly tools = new Map<string, ToolTiming>();
  readonly clock: Clock;
  constructor(clock: Clock = systemClock) { this.clock = clock; }
  task(sessionId: string, turn: number): TaskRuntime {
    const key = `${sessionId}:${turn}`;
    let runtime = this.tasks.get(key);
    if (!runtime) {
      runtime = { key, anchorWall: this.clock.wall(), anchorMono: this.clock.monotonic(), paused: [], pauseOwners: new Set(), pauseStart: null, lastPredictionAt: 0 };
      this.tasks.set(key, runtime);
    }
    return runtime;
  }
  time(runtime: TaskRuntime): number { return runtime.anchorWall + Math.max(0, this.clock.monotonic() - runtime.anchorMono); }
  pause(sessionId: string, turn: number): () => void {
    const runtime = this.task(sessionId, turn);
    const owner = {};
    if (!runtime.pauseOwners.size) runtime.pauseStart = this.time(runtime);
    runtime.pauseOwners.add(owner);
    let released = false;
    return () => {
      if (released) return; released = true;
      runtime.pauseOwners.delete(owner);
      if (!runtime.pauseOwners.size && runtime.pauseStart !== null) {
        runtime.paused.push({ start: runtime.pauseStart, end: this.time(runtime) });
        runtime.pauseStart = null;
      }
    };
  }
  pausedMs(sessionId: string, turn: number, from: number, to: number, durable: readonly PauseInterval[] = []): number {
    const runtime = this.tasks.get(`${sessionId}:${turn}`);
    const intervals = [...(runtime?.paused ?? []), ...durable];
    if (runtime?.pauseStart !== null && runtime?.pauseStart !== undefined) intervals.push({ start: runtime.pauseStart, end: to });
    let ms = 0, coveredEnd = from;
    for (const interval of intervals.sort((a, b) => a.start - b.start)) {
      const start = Math.max(from, interval.start, coveredEnd), end = Math.min(to, interval.end);
      if (end > start) ms += end - start;
      coveredEnd = Math.max(coveredEnd, end);
    }
    return Math.min(Math.max(0, to - from), ms);
  }
  startAttempt(sessionId: string, frame: Extract<AssistantStreamFrame, { type: 'start' }>, route: RouteFact): void {
    if (this.attempts.has(frame.attemptId)) return;
    this.task(sessionId, frame.turn);
    this.attempts.set(frame.attemptId, { ...emptyStreamStats(), id: frame.attemptId, sessionId, turn: frame.turn, step: frame.step, route: { ...route }, startedAt: this.clock.wall(), startedMono: this.clock.monotonic(), lastIndex: -1 });
  }
  chunk(frame: Extract<AssistantStreamFrame, { type: 'chunk' }>): void {
    const attempt = this.attempts.get(frame.attemptId);
    if (!attempt || frame.index <= attempt.lastIndex) return;
    // Monotonic durations cannot be distorted by an OS clock correction.
    const at = attempt.startedAt + Math.max(0, this.clock.monotonic() - attempt.startedMono);
    const next = observeChunk(attempt, frame.chunk, at);
    this.attempts.set(attempt.id, { ...attempt, ...next, lastIndex: frame.index });
  }
  endAttempt(id: string): { attempt: LiveAttempt; endedAt: number } | null {
    const attempt = this.attempts.get(id);
    if (!attempt) return null;
    this.attempts.delete(id);
    return { attempt, endedAt: attempt.startedAt + Math.max(0, this.clock.monotonic() - attempt.startedMono) };
  }
  activeAttempts(sessionId: string, turn: number): LiveAttempt[] { return [...this.attempts.values()].filter(attempt => attempt.sessionId === sessionId && attempt.turn === turn); }
  beginTool(sessionId: string, turn: number, callId: string): ToolTiming {
    const runtime = this.task(sessionId, turn);
    const key = `${sessionId}:${callId}`;
    const existing = this.tools.get(key);
    if (existing) return existing;
    const timing = { id: callId, sessionId, turn, startedAt: this.time(runtime), endedAt: null, workMs: 0 };
    this.tools.set(key, timing);
    return timing;
  }
  endTool(timing: ToolTiming): void {
    const runtime = this.task(timing.sessionId, timing.turn);
    timing.endedAt = this.time(runtime);
    timing.workMs = Math.max(0, timing.endedAt - timing.startedAt - this.pausedMs(timing.sessionId, timing.turn, timing.startedAt, timing.endedAt));
  }
  cleanupSession(sessionId: string): void {
    for (const [key, attempt] of this.attempts) if (attempt.sessionId === sessionId) this.attempts.delete(key);
    for (const [key, tool] of this.tools) if (tool.sessionId === sessionId) this.tools.delete(key);
    for (const [key] of this.tasks) if (key.startsWith(`${sessionId}:`)) this.tasks.delete(key);
  }
  clear(): void { this.tasks.clear(); this.attempts.clear(); this.tools.clear(); }
}
