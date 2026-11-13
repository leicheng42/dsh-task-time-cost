import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeObservations } from '../../src/host/runtime.ts';
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent';

function environment() {
  let wall = 10_000, mono = 0;
  const observations = new RuntimeObservations({ wall: () => wall, monotonic: () => mono });
  return { observations, advance: (ms: number) => { wall += ms; mono += ms; }, correctClock: (ms: number) => { wall += ms; } };
}
test('T10: nested human questions pause active time once, not twice', () => {
  const env = environment();
  const resumeApproval = env.observations.pause('s', 1);
  env.advance(60_000);
  const resumeQuestion = env.observations.pause('s', 1);
  env.advance(120_000);
  resumeApproval();
  env.advance(120_000);
  resumeQuestion(); resumeQuestion();
  assert.equal(env.observations.pausedMs('s', 1, 10_000, 310_000), 300_000);
  env.advance(10_000);
  assert.equal(env.observations.pausedMs('s', 1, 10_000, 320_000), 300_000);
});
test('execution clocks survive an OS wall clock correction', () => {
  const env = environment();
  const runtime = env.observations.task('s', 1);
  env.advance(5_000); env.correctClock(-120_000); env.advance(5_000);
  assert.equal(env.observations.time(runtime), 20_000);
});
test('tool timing removes only intersecting manual waits', () => {
  const env = environment();
  const tool = env.observations.beginTool('s', 1, 'tool');
  env.advance(1_000);
  const resume = env.observations.pause('s', 1);
  env.advance(300_000); resume(); env.advance(2_000);
  env.observations.endTool(tool);
  assert.equal(tool.workMs, 3_000);
});
test('R02/C05: frame indexes and true attempt IDs isolate duplicate and concurrent frames', () => {
  const env = environment();
  const route = { providerId: 'a', modelId: 'm', reasoningEffort: 'unknown' };
  const start = { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 1, step: 1 } as AssistantStreamFrame & { type: 'start' };
  env.observations.startAttempt('s', start, route);
  env.observations.startAttempt('s', start, route);
  env.advance(100);
  const chunk = { type: 'chunk', attemptId: 'attempt-1', revision: 1, index: 0, time: 10_100, chunk: { type: 'text-delta', index: 0, text: 'abc' } } as AssistantStreamFrame & { type: 'chunk' };
  env.observations.chunk(chunk); env.observations.chunk(chunk);
  assert.equal(env.observations.activeAttempts('s', 1)[0].textChars, 3);
  env.advance(1_000);
  const ended = env.observations.endAttempt('attempt-1');
  assert.equal(ended?.endedAt, 11_100);
  assert.equal(env.observations.endAttempt('attempt-1'), null);
  assert.equal(env.observations.activeAttempts('s', 1).length, 0);
});
