import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTask, DEFAULT_CLASSIFICATION_RULES } from '../../src/shared/workload.ts';
import { estimateContinuation } from '../../src/shared/time.ts';
import { inferOutputIncludesReasoning, normalizeUsage } from '../../src/shared/usage.ts';
import type { TaskFeatures } from '../../src/shared/workload.ts';

const features = (prompt: string): TaskFeatures => ({ prompt, currentInputTokens: 1_000 });

test('real short requests reach their real task kind instead of falling back to unknown', () => {
  // Every prompt below is taken from an actual Desktop session that previously
  // classified as `unknown`, which routed it to the generic workload template.
  const cases: [string, string][] = [
    ['反复迭代优化，实现这个插件功能，实现到最好的效果', 'code'],
    ['这个插件的价格一直显示无法完整估算费用，看起来像bug，读起来也别扭。重新设计一下', 'code'],
    ['把 release 目录里的包重新打包并验证', 'code'],
    ['重构 settings 面板', 'code'],
    ['帮我写一个 README', 'writing'],
    ['解释一下什么是 CAP 定理', 'question'],
    ['分析这个 CSV 文件', 'file-analysis'],
    ['调研一下最新的向量数据库并对比', 'research'],
  ];
  for (const [prompt, kind] of cases) assert.equal(classifyTask(features(prompt)).kind, kind, prompt);
});

test('a bare greeting and a continuation stay unknown rather than guessing', () => {
  for (const prompt of ['你好', '继续', '']) assert.equal(classifyTask(features(prompt)).kind, 'unknown', prompt);
});

test('code classification does not swallow explanation or artifact requests', () => {
  // A README is written content; the code rule must not claim every doc verb.
  assert.equal(classifyTask(features('写一份 README 说明这个项目怎么装')).kind, 'writing');
  // A pure definitional question stays a question even when it names a module.
  assert.equal(classifyTask(features('解释一下什么是 Cordis 插件')).kind, 'question');
});

test('every default rule stays valid, ordered and nonempty', () => {
  assert.ok(DEFAULT_CLASSIFICATION_RULES.length >= 5);
  const ids = new Set(DEFAULT_CLASSIFICATION_RULES.map(rule => rule.id));
  assert.equal(ids.size, DEFAULT_CLASSIFICATION_RULES.length);
  for (const rule of DEFAULT_CLASSIFICATION_RULES) {
    assert.ok(rule.patterns.length > 0, rule.id);
    for (const pattern of rule.patterns) assert.doesNotThrow(() => new RegExp(pattern, 'iu'), `${rule.id}: ${pattern}`);
  }
});

test('an exhausted plan with no comparable task history has no fabricated ETA', () => {
  assert.equal(estimateContinuation({ elapsedActiveMs: 3_381_000, completedRequests: 125, activeRequests: 0 }), null);
  assert.equal(estimateContinuation({ elapsedActiveMs: 40_000, completedRequests: 1, activeRequests: 0 }), null);
});

test('continuation uses one duration per completed comparable task', () => {
  const history = [30, 32, 35, 38, 40].map(minutes => ({ elapsedActiveMs: minutes * 60_000, completedRequests: 150 }));
  const span = estimateContinuation({ elapsedActiveMs: 20 * 60_000, completedRequests: 100, activeRequests: 1, history });
  assert.deepEqual(span, { low: 10 * 60_000, high: 20 * 60_000 });
  // Merely making more calls does not invent percentage-complete progress.
  assert.deepEqual(estimateContinuation({ elapsedActiveMs: 20 * 60_000, completedRequests: 120, activeRequests: 1, history }), span);
});

test('continuation excludes tasks that never reached current elapsed time or call count', () => {
  const history = [
    { elapsedActiveMs: 600_000, completedRequests: 200 },
    { elapsedActiveMs: 3_600_000, completedRequests: 5 },
    { elapsedActiveMs: Number.NaN, completedRequests: 200 },
    ...[30, 32, 35, 38].map(minutes => ({ elapsedActiveMs: minutes * 60_000, completedRequests: 150 })),
  ];
  assert.equal(estimateContinuation({ elapsedActiveMs: 1_200_000, completedRequests: 100, activeRequests: 0, history }), null);
});

test('a single long outlier does not set the entire continuation upper bound', () => {
  const history = [...Array.from({ length: 9 }, () => ({ elapsedActiveMs: 1_800_000, completedRequests: 200 })),
    { elapsedActiveMs: 86_400_000, completedRequests: 200 }];
  assert.deepEqual(estimateContinuation({ elapsedActiveMs: 1_200_000, completedRequests: 100, activeRequests: 0, history }), { low: 600_000, high: 600_000 });
});

test('a just-started task and a task beyond all past durations remain unknown', () => {
  const history = Array.from({ length: 5 }, () => ({ elapsedActiveMs: 60_000, completedRequests: 10 }));
  assert.equal(estimateContinuation({ elapsedActiveMs: 0, completedRequests: 1, activeRequests: 1, history }), null);
  assert.equal(estimateContinuation({ elapsedActiveMs: 120_000, completedRequests: 1, activeRequests: 0, history }), null);
});

test('output token semantics are inferred from the adapter arithmetic, never guessed', () => {
  // `total = prompt + output` proves output already contains reasoning tokens.
  assert.equal(inferOutputIncludesReasoning({ inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 100), true);
  // `total = prompt + output + reasoning` proves reasoning is billed separately.
  assert.equal(inferOutputIncludesReasoning({ inputTokens: 100, outputTokens: 50, reasoningTokens: 20, totalTokens: 170 }, 100), false);
  // An unrelated total is not evidence in either direction.
  assert.equal(inferOutputIncludesReasoning({ inputTokens: 100, outputTokens: 50, totalTokens: 999 }, 100), null);
  assert.equal(inferOutputIncludesReasoning({ outputTokens: 50 }, null), null);
});

test('inferred inclusive semantics complete the usage that previously stayed partial', () => {
  const semantics = { schema: 'dsh' as const, outputIncludesReasoning: 'unknown' as const, inferOutputIncludesReasoning: true };
  const raw = { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 20, totalTokens: 1_050 };
  const inferred = normalizeUsage(raw, semantics);
  assert.equal(inferred.outputTokens, 50);
  assert.equal(inferred.totalTokens, 1_050);
  assert.equal(inferred.status, 'complete');
  assert.ok(inferred.diagnostics.includes('inferred:output-reasoning-inclusive'));
  // Without the opt-in the same call stays explicitly unknown.
  const disabled = normalizeUsage(raw, { schema: 'dsh', outputIncludesReasoning: 'unknown' });
  assert.equal(disabled.outputTokens, null);
  assert.equal(disabled.status, 'partial');
  assert.ok(disabled.diagnostics.includes('unknown:output-reasoning-inclusion'));
});

test('configured semantics always win over inference', () => {
  const raw = { inputTokens: 100, outputTokens: 50, reasoningTokens: 20, totalTokens: 150 };
  const configured = normalizeUsage(raw, { schema: 'dsh', outputIncludesReasoning: false, inferOutputIncludesReasoning: true });
  assert.equal(configured.outputTokens, 70);
  assert.ok(!configured.diagnostics.some(diagnostic => diagnostic.startsWith('inferred:')));
});

test('a total with no room for cache activity proves the omitted cache fields are zero', () => {
  // Real shape: input 82 790 + output 321 = total 83 111 and no cache fields at
  // all. Nothing can be cached here, so this is not an unknown valuation.
  const semantics = { schema: 'dsh' as const, outputIncludesReasoning: 'unknown' as const, inferOutputIncludesReasoning: true };
  const usage = normalizeUsage({ inputTokens: 82_790, outputTokens: 321, totalTokens: 83_111 }, semantics);
  assert.equal(usage.cacheReadTokens, 0);
  assert.equal(usage.cacheWrite5mTokens, 0);
  assert.equal(usage.promptTokens, 82_790);
  assert.equal(usage.totalTokens, 83_111);
  assert.equal(usage.status, 'complete');
  assert.ok(usage.diagnostics.includes('inferred:no-cache-activity'));
  // Real cached shape: input 199 + cache read 156 032 + output 88 = total
  // 156 319. The omitted write field is the zero remainder, not unknown.
  const cached = normalizeUsage({ inputTokens: 199, cacheReadTokens: 156_032, outputTokens: 88, totalTokens: 156_319 }, semantics);
  assert.equal(cached.cacheWriteUnknownTokens, 0);
  assert.equal(cached.status, 'complete');
  assert.ok(cached.diagnostics.includes('inferred:cache-write-from-total'));
});

test('an unexplained remainder is only attributed once the output semantics are known', () => {
  // With output-includes-reasoning already configured, the residual is provably
  // a cache write and the total reconciles exactly.
  const resolved = normalizeUsage({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1_100 },
    { schema: 'dsh', outputIncludesReasoning: true, inferOutputIncludesReasoning: true });
  assert.equal(resolved.cacheWriteUnknownTokens, 50);
  assert.equal(resolved.totalTokens, 1_100);
  assert.equal(resolved.status, 'complete');
  // While the output split is still unknown the same numbers stay partial: two
  // unknowns cannot both be resolved from one total.
  const ambiguous = normalizeUsage({ inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, totalTokens: 1_100 },
    { schema: 'dsh', outputIncludesReasoning: 'unknown', inferOutputIncludesReasoning: true });
  assert.equal(ambiguous.cacheWriteUnknownTokens, null);
  assert.equal(ambiguous.status, 'partial');
});

test('an entirely empty usage report completes without inventing consumption', () => {
  const semantics = { schema: 'dsh' as const, outputIncludesReasoning: 'unknown' as const, inferOutputIncludesReasoning: true };
  const usage = normalizeUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }, semantics);
  for (const value of [usage.inputTokens, usage.cacheReadTokens, usage.outputTokens, usage.totalTokens]) assert.equal(value, 0);
  assert.equal(usage.status, 'complete');
  assert.ok(usage.diagnostics.includes('inferred:empty-usage-report'));
});

test('inference stays off for a route whose semantics are already configured', () => {
  // The opt-in exists so an unconfigured route is not treated as broken. Once a
  // route declares exclusive output, an inclusive-looking total must not win:
  // the missing reasoning count stays unknown instead of being silently zeroed.
  const usage = normalizeUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    { schema: 'dsh', outputIncludesReasoning: false, inferOutputIncludesReasoning: true });
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.status, 'partial');
  assert.ok(!usage.diagnostics.some(diagnostic => diagnostic.startsWith('inferred:')));
});
