import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG, DEFAULT_TEMPLATES, validateConfig, validateTemplates, classifyTask, estimateWorkload, updateWorkload, importBaselines, validateBaselines, parseCsv, estimateWorkloadTime, selectPerformance, templatesFromBaselines, performancePriorsFromBaselines } from '../../src/shared/index.ts';
import type { BaselineRecord, RouteIdentity, TaskFeatures } from '../../src/shared/index.ts';

const route: RouteIdentity = { providerId: 'unknown', endpointFingerprint: 'unknown', modelId: 'unknown', requestMode: 'unknown', reasoningEffort: 'unknown', serviceTier: 'unknown', mixedRoute: true };
const features = (prompt: string, extra: Partial<TaskFeatures> = {}): TaskFeatures => ({ prompt, currentInputTokens: 1_000, ...extra });
function baseline(overrides: Partial<BaselineRecord> = {}): BaselineRecord { return { seedId: 'mean-v1', taskKind: 'code', appliesTo: { modelId: 'm', requestMode: 'mixed' }, date: '2026-11-12', sourceUrl: 'https://example.com/original-trials', dataVersion: 'source-v1', timingBasis: 'agent_execution', statistic: 'mean', sampleCount: 10, scope: 'test fixture only, specific harness', sourceKind: 'public-measured', metrics: { requestCount: { mean: 4 }, visibleOutputTokens: { mean: 2_000 } }, ...overrides }; }

test('direct SVG generation is writing; modifying an existing repository and testing is code', () => {
  assert.equal(classifyTask(features('直接生成 SVG 片段，画一个时钟')).kind, 'writing');
  assert.equal(classifyTask(features('修改现有项目的 SVG 组件并运行测试')).kind, 'code');
  assert.equal(classifyTask(features('写1000字故事，主人公是一位程序员')).kind, 'writing');
  assert.equal(classifyTask(features('Write an SVG snippet with a tiny clock')).kind, 'writing');
  assert.equal(classifyTask(features('Fix the bug in this repository and run tests')).kind, 'code');
});
test('default classifier covers all six task kinds and records heuristic provenance', () => {
  for (const [prompt, kind] of [['什么是首字延迟？', 'question'], ['请输出一篇文章', 'writing'], ['分析这份PDF文件', 'file-analysis'], ['修复这个项目里的问题', 'code'], ['多步搜索并对比来源，做一份调研', 'research'], ['继续', 'unknown']]) {
    const result = classifyTask(features(prompt));
    assert.equal(result.kind, kind); assert.ok(result.reasons.includes('classification:heuristic'));
  }
});
test('classification rule order and exclusions are configurable', () => {
  const rules = [{ id: 'specific-writing', kind: 'writing' as const, patterns: ['clock'], excludePatterns: ['repository'] }, { id: 'repo', kind: 'code' as const, patterns: ['repository'] }];
  assert.equal(classifyTask(features('clock'), rules).kind, 'writing');
  assert.equal(classifyTask(features('clock repository'), rules).kind, 'code');
});
test('six default templates match specification and retain per-call mode/dependencies', () => {
  validateTemplates(DEFAULT_TEMPLATES);
  const plan = estimateWorkload(features('修改现有项目并运行测试'), route);
  assert.equal(plan.low.requests.length, 6); assert.equal(plan.high.requests.length, 40);
  assert.equal(plan.low.requests[0].route.requestMode, 'mixed'); assert.equal(plan.low.requests.at(-1)!.route.requestMode, 'text');
  assert.ok(plan.low.requests.slice(0, -1).every(request => request.route.requestMode === 'mixed'));
  assert.deepEqual(plan.low.requests[1].dependsOn, ['tool-1']); assert.equal(plan.origin, 'heuristic');
});
test('later request input includes retained outputs/tool returns, not first input times count', () => {
  const plan = estimateWorkload(features('修改现有项目并运行测试'), route);
  assert.equal(plan.high.requests[0].inputTokens!.high, 1_000);
  assert.ok(plan.high.requests[1].inputTokens!.high > 3_000);
  assert.ok(plan.high.requests[7].inputTokens!.high > plan.high.requests[1].inputTokens!.high);
});
test('unknown current input remains null; attachment Token estimate does not claim model-read input', () => {
  const plan = estimateWorkload(features('阅读附件', { currentInputTokens: null, attachmentTokens: { low: 5_000, high: 10_000 } }), route);
  assert.ok(plan.high.requests.every(request => request.inputTokens === null));
  assert.equal(plan.kind, 'file-analysis');
});
test('explicit requested length, artifact count and observable plan affect budgets', () => {
  const long = estimateWorkload(features('写10000字故事'), route);
  const output = long.high.requests.reduce((sum, request) => sum + request.visibleOutputTokens.high, 0);
  assert.ok(output >= 20_000); assert.equal(long.kind, 'writing');
  const artifacts = estimateWorkload(features('写一篇文章', { artifactCount: 3 }), route);
  assert.ok(artifacts.high.requests.reduce((sum, request) => sum + request.visibleOutputTokens.high, 0) >= 9_000);
  const steps = estimateWorkload(features('修改现有项目', { observedPlanSteps: 60 }), route);
  assert.equal(steps.high.requests.length, 60);
});
test('request modes never treat intermediate tool parameters as body-speed budgets', () => {
  const plan = estimateWorkload(features('多步调研多个供应商'), route);
  assert.ok(plan.high.requests.slice(0, -1).every(request => request.visibleTextTokens === null));
  assert.ok(plan.high.requests.at(-1)!.visibleTextTokens !== null);
  assert.ok(plan.high.requests.every(request => request.reasoningTokens === null && request.cacheReadRatio === null));
});
test('transient prompts are absent from returned plans and local history', () => {
  const secret = '修改项目，内部秘密SECRET-CONTENT';
  const plan = estimateWorkload(features(secret), route);
  assert.doesNotMatch(JSON.stringify(plan), /SECRET-CONTENT/);
  const learned = updateWorkload(null, { kind: 'code', outcome: 'completed', requestCount: 4, visibleOutputTokens: 2_000, toolMs: 30_000 });
  assert.doesNotMatch(JSON.stringify(learned), /SECRET-CONTENT/);
});
test('workload EWMA updates independent request/output/tool quantities, excluding supplier speed', () => {
  const previous = { kind: 'code' as const, requestCount: 4, visibleOutputTokens: 2_000, toolMs: 20_000, samples: 1, lastObservedAtMs: null, sourceKind: 'local-measured' as const };
  const result = updateWorkload(previous, { kind: 'code', outcome: 'completed', requestCount: 8, visibleOutputTokens: 4_000, toolMs: 40_000 }, 0.2);
  assert.equal(result.accepted, true); assert.ok(Math.abs(result.history!.requestCount - 4.8) < 1e-12); assert.equal(result.history!.visibleOutputTokens, 2_400); assert.equal(result.history!.toolMs, 24_000);
  assert.equal(previous.samples, 1);
});
test('R01 scope changes, cancellations, failures, truncation, timeout and missing data do not train success workload', () => {
  const common = { kind: 'code' as const, requestCount: 3, visibleOutputTokens: 1_000, toolMs: 5_000 };
  for (const outcome of ['cancelled', 'failed', 'timeout', 'truncated', 'interrupted'] as const) assert.equal(updateWorkload(null, { ...common, outcome }).accepted, false);
  assert.equal(updateWorkload(null, { ...common, outcome: 'completed', appendedRequirements: true }).accepted, false);
  assert.equal(updateWorkload(null, { ...common, outcome: 'completed', visibleOutputTokens: null }).accepted, false);
});
test('R04 offline/no public data still yields engineering time while keeping unknown billing assumptions', () => {
  const plan = estimateWorkload(features('什么是首正文等待？'), route);
  const estimated = estimateWorkloadTime(plan, requestRoute => selectPerformance(requestRoute, [], [], 0));
  assert.ok(estimated.remainingMs && estimated.remainingMs.high > 0); assert.equal(estimated.origin, 'heuristic');
  assert.ok(estimated.reasons.includes('engineering-assumption')); assert.equal(plan.low.requests[0].reasoningTokens, null);
});
test('default config and bundled JSON match, validate, and have no extra model calls', () => {
  const saved = JSON.parse(readFileSync(new URL('../../data/defaults.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateConfig(saved), DEFAULT_CONFIG); assert.equal(saved.extraPlanningCall, false);
  for (const invalid of [{ performanceAlpha: 0 }, { workloadAlpha: 1.1 }, { heuristicVisibleTps: Infinity }, { referenceLowFactor: 3 }, { minConditionalSamples: 0 }, { toolResultTokensPerCall: { low: 5, high: 1 } }]) assert.throws(() => validateConfig(invalid));
});
test('invalid/inverted template budgets are rejected before use', () => {
  assert.throws(() => validateTemplates([{ ...DEFAULT_TEMPLATES[0], requestCount: { low: 2, high: 1 } }]));
  assert.throws(() => estimateWorkload(features('anything', { currentInputTokens: -1 }), route));
});
test('bundled baselines carry all provenance and only heuristic assumptions', () => {
  const document = readFileSync(new URL('../../data/baselines.json', import.meta.url), 'utf8');
  const result = importBaselines(document, 'json');
  assert.equal(result.records.length, 7);
  assert.ok(result.records.every(record => record.sourceKind === 'heuristic' && record.sampleCount === null && record.statistic === 'assumption-range'));
});
test('JSON import preserves means without inventing quantiles or measured task rows', () => {
  const result = importBaselines(JSON.stringify([baseline()]), 'json');
  assert.deepEqual(result.records[0].metrics.requestCount, { mean: 4 });
  assert.equal(result.records[0].statistic, 'mean');
  assert.throws(() => validateBaselines([baseline({ metrics: { requestCount: { low: 2, high: 5 } } })]));
});
test('CSV import handles comma, embedded newline and quoted text with explicit mean columns', () => {
  const csv = 'seedId,taskKind,date,sourceUrl,dataVersion,timingBasis,statistic,sampleCount,scope,sourceKind,modelId,requestCount.mean\r\ntrial,code,2026-11-12,https://example.com,data-v1,agent_execution,mean,3,"specific, harness\nwith ""quotes""",public-measured,m,4\r\n';
  const result = importBaselines(csv, 'csv');
  assert.deepEqual(result.records[0].metrics.requestCount, { mean: 4 });
  assert.equal(result.records[0].scope, 'specific, harness\nwith "quotes"');
});
test('failed import is atomic and a new version keeps the previous usable version', () => {
  const original = [baseline()];
  assert.throws(() => importBaselines(JSON.stringify([baseline({ sampleCount: -1 })]), 'json', original));
  assert.equal(original[0].sampleCount, 10);
  const result = importBaselines(JSON.stringify([baseline({ dataVersion: 'source-v2' })]), 'json', original);
  assert.equal(result.records.length, 2); assert.equal(original.length, 1);
});
test('baseline bridge only applies workload records to compatible route and preserves mean provenance', () => {
  const measured = baseline({ appliesTo: { modelId: 'known-model' }, metrics: { requestCount: { mean: 4 }, visibleOutputTokens: { mean: 2_000 }, toolMs: { mean: 20_000 } } });
  const matching = templatesFromBaselines([measured], { ...route, modelId: 'known-model' });
  const code = matching.find(template => template.kind === 'code')!;
  assert.deepEqual(code.requestCount, { low: 4, high: 4 }); assert.match(code.sourceId!, /mean/);
  const other = templatesFromBaselines([measured], route).find(template => template.kind === 'code')!;
  assert.deepEqual(other.requestCount, { low: 6, high: 40 });
  const incomplete = templatesFromBaselines([baseline()], { ...route, modelId: 'm', requestMode: 'mixed' }).find(template => template.kind === 'code')!;
  assert.equal(incomplete.sourceKind, 'heuristic');
});
test('public performance prior requires exact explicit endpoint and compatible settings', () => {
  const measured = baseline({ appliesTo: { modelId: 'm', endpointFingerprint: 'known-endpoint', reasoningEffort: 'high', requestMode: 'text' }, metrics: { firstTextMs: { mean: 5_000 }, visibleTps: { mean: 100 } } });
  const priors = performancePriorsFromBaselines([measured]);
  const matchingRoute = { ...route, endpointFingerprint: 'known-endpoint', modelId: 'm', reasoningEffort: 'high', requestMode: 'text' as const };
  const matched = selectPerformance(matchingRoute, [], priors, 0);
  assert.equal(matched.match, 'public-prior'); assert.equal(matched.visibleTps, 100);
  assert.equal(matched.metricOrigins.speed, 'public-measured'); assert.equal(matched.metricOrigins.total, 'heuristic');
  assert.equal(matched.trust, 'reference');
  assert.equal(selectPerformance({ ...matchingRoute, endpointFingerprint: 'different-endpoint' }, [], priors, 0).match, 'heuristic');
  assert.equal(selectPerformance({ ...matchingRoute, reasoningEffort: 'low' }, [], priors, 0).match, 'heuristic');
  const endpointMissing = performancePriorsFromBaselines([baseline({ appliesTo: { modelId: 'm' }, metrics: { visibleTps: { mean: 100 } } })]);
  assert.equal(selectPerformance(matchingRoute, [], endpointMissing, 0).match, 'heuristic');
});
test('imported configurable engineering performance centers remain heuristic', () => {
  const initial = baseline({ sourceKind: 'heuristic', statistic: 'assumption-range', sampleCount: null, sourceUrl: null, appliesTo: { modelId: '*' }, metrics: { firstTextMs: { low: 4_000, high: 8_000 }, visibleTps: { low: 10, high: 30 } } });
  const priors = performancePriorsFromBaselines([initial]);
  const selected = selectPerformance(route, [], priors, 0);
  assert.equal(selected.firstTextMs, 6_000); assert.equal(selected.visibleTps, 20); assert.equal(selected.sourceKind, 'heuristic');
  assert.equal(priors[0].sampleCount, null);
});
test('import rejects malformed CSV, unsupported schemas, unsupported quantiles and fabricated heuristic samples', () => {
  assert.throws(() => parseCsv('a,b\n"unclosed,b'));
  assert.throws(() => parseCsv('a,b\n"ok"trailing,b'));
  assert.throws(() => importBaselines('{"schemaVersion":2,"records":[]}', 'json'));
  assert.throws(() => validateBaselines([baseline({ statistic: 'quantiles', sampleCount: null, metrics: { totalCallMs: { p50: 1 } } })]));
  assert.throws(() => validateBaselines([baseline({ sourceKind: 'heuristic' })]));
});
