import { validateConfig } from './config.ts';
import { inferWorkloadScale, SCOPE_BUDGETS } from './scope.ts';
import type { WorkloadScale } from './scope.ts';
import type { EstimatorConfig } from './config.ts';
import { assertSpan, ewma, nonnegative } from './types.ts';
import type { EstimateOrigin, Outcome, RouteIdentity, SourceKind, Span, TaskKind } from './types.ts';

export interface TaskFeatures {
  /** Transient classifier input. Never included in returned plans/history. */
  prompt: string;
  workloadScale?: WorkloadScale;
  currentInputTokens: number | null;
  explicitOutputTokens?: Span;
  artifactCount?: number;
  fileCount?: number;
  attachmentTokens?: Span;
  observedPlanSteps?: number;
}
export interface ClassificationRule { id: string; kind: TaskKind; patterns: string[]; excludePatterns?: string[]; requiresAll?: boolean }
export interface WorkloadTemplate { kind: TaskKind; requestCount: Span; visibleOutputTokens: Span; toolMs: Span; sourceKind: SourceKind; sourceId?: string }
export interface RequestBudget {
  id: string;
  route: RouteIdentity;
  inputTokens: Span | null;
  visibleTextTokens: Span | null;
  /** Includes observable body OR tool parameters, never includes hidden reasoning. */
  visibleOutputTokens: Span;
  reasoningTokens: Span | null;
  cacheReadRatio: Span | null;
  dependsOn: string[];
  sourceKind: SourceKind;
}
export interface ToolBudget { id: string; durationMs: Span; dependsOn: string[]; resource?: string; sourceKind: SourceKind }
export interface PlanScenario { requests: RequestBudget[]; tools: ToolBudget[] }
export interface WorkloadPlan { kind: TaskKind; low: PlanScenario; high: PlanScenario; origin: EstimateOrigin; reasons: string[]; workloadSamples: number; sourceIds: string[] }
export interface WorkloadSample { requestCount: number; visibleOutputTokens: number; toolMs: number }
export interface WorkloadHistory { kind: TaskKind; requestCount: number; visibleOutputTokens: number; toolMs: number; samples: number; lastObservedAtMs: number | null; sourceKind: 'local-measured' }
export interface WorkloadObservation {
  kind: TaskKind;
  outcome: Outcome;
  requestCount: number;
  visibleOutputTokens: number | null;
  toolMs: number | null;
  observedAtMs?: number;
  scopeChanged?: boolean;
  appendedRequirements?: boolean;
  dataComplete?: boolean;
}

export const DEFAULT_TEMPLATES: readonly WorkloadTemplate[] = Object.freeze([
  { kind: 'question', requestCount: { low: 1, high: 2 }, visibleOutputTokens: { low: 150, high: 800 }, toolMs: { low: 0, high: 0 }, sourceKind: 'heuristic' },
  { kind: 'writing', requestCount: { low: 1, high: 3 }, visibleOutputTokens: { low: 600, high: 4_000 }, toolMs: { low: 0, high: 10_000 }, sourceKind: 'heuristic' },
  { kind: 'file-analysis', requestCount: { low: 2, high: 10 }, visibleOutputTokens: { low: 800, high: 6_000 }, toolMs: { low: 10_000, high: 300_000 }, sourceKind: 'heuristic' },
  { kind: 'code', requestCount: { low: 6, high: 40 }, visibleOutputTokens: { low: 1_200, high: 15_000 }, toolMs: { low: 60_000, high: 1_200_000 }, sourceKind: 'heuristic' },
  { kind: 'research', requestCount: { low: 4, high: 20 }, visibleOutputTokens: { low: 1_500, high: 12_000 }, toolMs: { low: 60_000, high: 900_000 }, sourceKind: 'heuristic' },
  { kind: 'unknown', requestCount: { low: 3, high: 15 }, visibleOutputTokens: { low: 500, high: 8_000 }, toolMs: { low: 30_000, high: 600_000 }, sourceKind: 'heuristic' },
] as WorkloadTemplate[]);

/**
 * Ordered local classifier. Rules run top-down; the first match wins.
 *
 * Real prompts are short requests, not specifications: "重新打包并验证" or
 * "重构 settings 面板" name a code action with no repository noun next to it,
 * and an earlier rule set that demanded `verb + project-noun` sent nearly every
 * real task to `unknown`. Each rule therefore accepts either a verb adjacent to
 * a domain noun or a strong domain noun on its own, in Chinese and English.
 */
export const DEFAULT_CLASSIFICATION_RULES: readonly ClassificationRule[] = Object.freeze([
  {
    id: 'engineering-work', kind: 'code',
    // A code verb whose object is a document is writing, and a definitional
    // request that merely names a module is still a question.
    excludePatterns: [
      '(?:写|撰写|起草|生成|输出|整理成|改写成).{0,12}(?:README|readme|CHANGELOG|文档|说明|报告|文章|文案|摘要|演讲稿)',
      '(?:^|[。！？!?]\\s*)(?:请)?(?:解释|什么是|为什么|如何理解|介绍|告诉我|怎么理解)',
      '^\\s*(?:what|why|how|explain|tell me)\\b',
    ],
    patterns: [
      // A development verb within 24 characters of a development noun.
      '(?:迭代|优化|实现|开发|重构|调试|修复|部署|打包|编译|构建|安装|升级|迁移|接入|封装|抽取|改造|改写|补全|落地|联调|排查|定位|复现|验证|跑通|跑一下|改|写|加|删|拆|合并|升级).{0,24}(?:插件|接口|组件|模块|函数|脚本|配置文件|配置项|配置|仓库|代码库|代码|项目|单元测试|集成测试|测试|用例|面板|页面|服务|命令|样式|类型|编译|构建|打包|部署|报错|崩溃|异常|bug|patch|release|api|API|CLI|SDK|schema)',
      // A strong engineering noun standing alone already identifies the work.
      '(?:插件|代码库|单元测试|集成测试|构建产物|依赖版本|类型定义|接口定义|错误栈|异常栈|回归测试|打包发布).{0,24}(?:修|改|做|写|跑|装|发|实现|优化|重构)',
      '(?:插件|代码库|单元测试|集成测试|类型定义|接口定义|错误栈|异常栈|构建脚本)',
      '(?:重新|再次)?(?:打包|编译|构建|部署|重构|重构一下|跑一遍测试|运行测试|跑测试)',
      '\\b(?:fix|refactor|implement|debug|deploy|build|compile|migrate|upgrade|optimi[sz]e|iterate|patch)\\b.{0,32}\\b(?:bug|repo\\w*|code\\w*|project|test\\w*|plugin|module|component|script|api|build|config|release)\\b',
      '\\b(?:bug|refactor|unit tests?|pull request|stack trace|regression|build failing)\\b',
    ],
  },
  {
    id: 'direct-artifact', kind: 'writing',
    patterns: [
      '(?:直接|只需|仅需|生成|输出|写|撰写|起草|润色|翻译|总结|概括|整理成|改写成).{0,24}(?:SVG|svg|HTML片段|代码片段|故事|文章|文案|摘要|总结|诗|邮件|README|readme|readme文档|文档|公告|说明|报告|致辞|演讲稿)',
      '\\b(?:write|generate|compose|draft|summarize|translate|polish|rewrite)\\b.{0,32}\\b(?:story|article|essay|svg|snippet|summary|email|readme|docs?|post|poem|copy)\\b',
      '\\b(?:README|CHANGELOG)\\b',
    ],
  },
  {
    id: 'research', kind: 'research',
    patterns: [
      '调研|研究.{0,16}(?:资料|来源|报告|对比|现状)|多步.{0,10}(?:搜索|检索)|联网.{0,10}(?:搜索|查找)|(?:搜索|查找|检索|调研|了解).{0,20}(?:最新|对比|资料|来源|现状|竞品)',
      '\\b(?:research|investigate|search the web|find sources|look up|compare)\\b',
    ],
  },
  {
    id: 'files', kind: 'file-analysis',
    patterns: [
      '(?:分析|阅读|检查|审阅|提取|解析|统计|对照).{0,24}(?:文件|附件|文档|表格|PDF|pdf|CSV|csv|数据集|日志|截图|图片)',
      '\\b(?:analy[sz]e|read|review|extract|parse|inspect)\\b.{0,32}\\b(?:file|document|attachment|pdf|spreadsheet|csv|dataset|log|screenshot)\\b',
    ],
  },
  {
    id: 'explanation', kind: 'question',
    patterns: ['^(?:请)?(?:解释|什么是|为什么|如何理解|介绍|告诉我|怎么理解)|[?？]$', '^\\s*(?:what|why|how|explain|tell me)\\b'],
  },
]);

export function validateTemplates(templates: readonly WorkloadTemplate[]): void {
  const kinds = new Set<TaskKind>();
  for (const template of templates) {
    if (!DEFAULT_TEMPLATES.some(item => item.kind === template.kind) || kinds.has(template.kind)) throw new TypeError('Unknown/duplicate workload kind');
    kinds.add(template.kind);
    assertSpan(template.requestCount, 'requestCount');
    assertSpan(template.visibleOutputTokens, 'visibleOutputTokens');
    assertSpan(template.toolMs, 'toolMs');
    if (template.requestCount.low < 1 || !Number.isSafeInteger(template.requestCount.low) || !Number.isSafeInteger(template.requestCount.high)) throw new TypeError('Request counts must be positive integers');
    if (!['heuristic', 'public-measured', 'local-measured'].includes(template.sourceKind)) throw new TypeError('Invalid workload source');
  }
}

export function validateClassificationRules(rules: readonly ClassificationRule[]): void {
  const ids = new Set<string>();
  for (const rule of rules) {
    if (!rule.id || ids.has(rule.id) || !DEFAULT_TEMPLATES.some(template => template.kind === rule.kind) || !Array.isArray(rule.patterns) || !rule.patterns.length || (rule.requiresAll !== undefined && typeof rule.requiresAll !== 'boolean')) throw new TypeError('Invalid classification rule');
    ids.add(rule.id);
    for (const pattern of [...rule.patterns, ...(rule.excludePatterns ?? [])]) {
      if (typeof pattern !== 'string' || !pattern) throw new TypeError('Classification patterns must be nonempty strings');
      new RegExp(pattern, 'iu');
    }
  }
}

export function classifyTask(input: TaskFeatures, rules: readonly ClassificationRule[] = DEFAULT_CLASSIFICATION_RULES): { kind: TaskKind; reasons: string[] } {
  validateClassificationRules(rules);
  for (const rule of rules) {
    const tests = rule.patterns.map(pattern => new RegExp(pattern, 'iu').test(input.prompt));
    const excluded = (rule.excludePatterns ?? []).some(pattern => new RegExp(pattern, 'iu').test(input.prompt));
    if (!excluded && (rule.requiresAll ? tests.every(Boolean) : tests.some(Boolean))) return { kind: rule.kind, reasons: [`classification-rule:${rule.id}`, 'classification:heuristic'] };
  }
  if ((input.fileCount ?? 0) > 0 || input.attachmentTokens !== undefined) return { kind: 'file-analysis', reasons: ['observable-attachments', 'classification:heuristic'] };
  return { kind: 'unknown', reasons: ['no-classification-match', 'classification:heuristic'] };
}

export function estimateWorkload(input: TaskFeatures, route: RouteIdentity, options: { config?: Partial<EstimatorConfig>; templates?: readonly WorkloadTemplate[]; rules?: readonly ClassificationRule[]; history?: WorkloadHistory[]; observations?: readonly WorkloadSample[] } = {}): WorkloadPlan {
  const config = validateConfig(options.config);
  const templates = options.templates ?? DEFAULT_TEMPLATES;
  validateTemplates(templates);
  if (input.currentInputTokens !== null && (!Number.isSafeInteger(input.currentInputTokens) || input.currentInputTokens < 0)) throw new TypeError('Invalid current input Token count');
  for (const key of ['artifactCount', 'fileCount', 'observedPlanSteps'] as const) if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key]! < (key === 'fileCount' ? 0 : 1))) throw new TypeError(`Invalid ${key}`);
  if (input.attachmentTokens) assertSpan(input.attachmentTokens, 'attachmentTokens');
  const detected = classifyTask(input, options.rules);
  const scale = input.workloadScale ?? inferWorkloadScale(input.prompt, detected.kind);
  const classification = scale === 'task' ? detected : { kind: 'code' as const, reasons: [...detected.reasons, `scope-workload:${scale}`] };
  const selected = templates.find(template => template.kind === classification.kind) ?? templates.find(template => template.kind === 'unknown');
  const template: WorkloadTemplate | undefined = selected && scale !== 'task' && selected.sourceId !== 'executing-ai-plan'
    ? { ...selected, ...SCOPE_BUDGETS[scale], sourceKind: 'heuristic', sourceId: `engineering-scope-${scale}-v1` } : selected;
  if (!template) throw new TypeError('No compatible workload template');
  const history = scale === 'task' ? options.history?.find(item => item.kind === classification.kind && item.samples > 0) : undefined;
  let count = { ...template.requestCount };
  let output = { ...template.visibleOutputTokens };
  let tool = { ...template.toolMs };
  const reasons = [...classification.reasons, 'serial-conservative-dependencies', 'cache-ratio-unknown', 'reasoning-budget-unknown'];
  const observations = (options.observations ?? []).filter(sample => Number.isSafeInteger(sample.requestCount) && sample.requestCount >= 1
    && Number.isSafeInteger(sample.visibleOutputTokens) && sample.visibleOutputTokens >= 0 && Number.isFinite(sample.toolMs) && sample.toolMs >= 0).slice(-config.maxSamplesPerBucket);
  const empirical = observations.length >= config.minConditionalSamples;
  if (empirical) {
    // Recentring the original template never learns a narrower spread. Use the
    // central observed distribution once comparable completed tasks support it.
    const range = (key: keyof WorkloadSample): Span => {
      const values = observations.map(sample => sample[key]).sort((a, b) => a - b);
      return { low: values[Math.floor((values.length - 1) * 0.2)]!, high: values[Math.ceil((values.length - 1) * 0.8)]! };
    };
    count = range('requestCount'); output = range('visibleOutputTokens'); tool = range('toolMs');
    reasons.push('local-workload-distribution');
  } else if (history) {
    for (const key of ['requestCount', 'visibleOutputTokens', 'toolMs', 'samples'] as const) nonnegative(history[key], key);
    count = scaleRange(count, history.requestCount);
    count = { low: Math.max(1, Math.floor(count.low)), high: Math.max(1, Math.ceil(count.high)) };
    output = scaleRange(output, history.visibleOutputTokens);
    tool = scaleRange(tool, history.toolMs);
    reasons.push('local-workload-ewma');
  } else reasons.push(scale !== 'task' ? 'scope-engineering-prior' : 'engineering-workload-template');
  const artifacts = input.artifactCount ?? 1;
  if (artifacts > 1) {
    output = { low: output.low * artifacts, high: output.high * artifacts };
    if (!['question', 'writing'].includes(classification.kind)) count.high = Math.max(count.high, artifacts);
    reasons.push('explicit-artifact-count');
  }
  if (input.observedPlanSteps !== undefined) {
    count.high = Math.max(count.high, input.observedPlanSteps);
    reasons.push('observable-plan-steps');
  }
  if ((input.fileCount ?? 0) > 4) {
    const batches = Math.ceil(input.fileCount! / 4);
    count.high = Math.max(count.high, batches);
    tool.high *= batches;
    reasons.push('file-batch-assumption');
  }
  const length = input.explicitOutputTokens ?? outputLengthFromPrompt(input.prompt);
  if (length) {
    assertSpan(length, 'explicitOutputTokens');
    // Requested length describes the final artifact; intermediate output is retained separately.
    const overhead = ['code', 'research', 'file-analysis'].includes(classification.kind) ? 1.5 : 1;
    output = { low: Math.max(output.low, length.low * artifacts), high: Math.max(output.high, length.high * artifacts * overhead) };
    reasons.push(input.explicitOutputTokens ? 'explicit-output-token-budget' : 'requested-length-token-conversion:heuristic');
  }
  const origin: EstimateOrigin = empirical ? 'local-measured' : history ? (template.sourceKind === 'local-measured' ? 'local-measured' : 'mixed') : template.sourceKind;
  return {
    kind: classification.kind,
    low: buildScenario(count.low, output.low, tool.low, input.currentInputTokens, route, classification.kind, template.sourceKind, config, false, length ? length.low * artifacts : null),
    high: buildScenario(count.high, output.high, tool.high, input.currentInputTokens, route, classification.kind, template.sourceKind, config, true, length ? length.high * artifacts : null),
    origin, reasons, workloadSamples: empirical ? observations.length : history?.samples ?? 0,
    sourceIds: empirical ? [`local-workload-distribution:${classification.kind}:${observations.length}`]
      : [template.sourceId ?? `engineering-${template.kind}-v1`, ...(history ? [`local-workload:${history.kind}:${history.samples}`] : [])],
  };
}

function outputLengthFromPrompt(prompt: string): Span | null {
  const match = prompt.match(/(?:约|大约|写|输出|write|about)?\s*(\d{2,7})\s*(字|words?)/iu);
  if (!match) return null;
  const length = Number(match[1]);
  const chinese = match[2] === '字';
  return { low: Math.floor(length * (chinese ? 1 : 1.2)), high: Math.ceil(length * (chinese ? 2 : 1.8)) };
}
function scaleRange(range: Span, center: number): Span {
  const old = (range.low + range.high) / 2;
  return old > 0 ? { low: range.low * center / old, high: range.high * center / old } : { low: center, high: center };
}
function buildScenario(count: number, totalOutput: number, totalToolMs: number, initialInput: number | null, route: RouteIdentity, kind: TaskKind, sourceKind: SourceKind, config: EstimatorConfig, high: boolean, finalOutput: number | null): PlanScenario {
  const requests: RequestBudget[] = [];
  const tools: ToolBudget[] = [];
  const toolCount = totalToolMs > 0 ? Math.max(1, count - 1) : 0;
  let retained = 0;
  let dependency: string[] = [];
  const finalBudget = count === 1 ? totalOutput : Math.min(totalOutput, Math.max(finalOutput ?? 0, totalOutput * 0.6));
  const intermediateBudget = count > 1 ? (totalOutput - finalBudget) / (count - 1) : 0;
  for (let index = 0; index < count; index++) {
    const id = `request-${index + 1}`;
    const final = index === count - 1;
    const visible = Math.ceil(final ? finalBudget : intermediateBudget);
    // A known mode supplied by the current route must survive classification:
    // otherwise the live tool profile is discarded for unknown/text priors.
    const mode = route.requestMode !== 'unknown' ? route.requestMode
      : kind === 'unknown' ? 'unknown' : final || ['question', 'writing'].includes(kind) ? 'text' : 'mixed';
    const current = initialInput === null ? null : { low: Math.floor(initialInput + retained), high: Math.ceil(initialInput + retained) };
    requests.push({ id, route: { ...route, requestMode: mode }, inputTokens: current, visibleTextTokens: mode === 'text' ? { low: visible, high: visible } : null, visibleOutputTokens: { low: visible, high: visible }, reasoningTokens: null, cacheReadRatio: null, dependsOn: [...dependency], sourceKind });
    retained += visible;
    dependency = [id];
    if (index < toolCount) {
      const toolId = `tool-${index + 1}`;
      tools.push({ id: toolId, durationMs: { low: totalToolMs / toolCount, high: totalToolMs / toolCount }, dependsOn: [id], resource: 'tool', sourceKind });
      retained += high ? config.toolResultTokensPerCall.high : config.toolResultTokensPerCall.low;
      dependency = [toolId];
    }
  }
  return { requests, tools };
}

export function updateWorkload(previous: WorkloadHistory | null, observation: WorkloadObservation, alpha = 0.2): { history: WorkloadHistory | null; accepted: boolean; reasons: string[] } {
  // Validate alpha even when the observation is excluded.
  ewma(0, 0, alpha);
  const reasons: string[] = [];
  if (observation.outcome !== 'completed') reasons.push(`outcome:${observation.outcome}`);
  if (observation.scopeChanged || observation.appendedRequirements) reasons.push('task-scope-changed');
  if (observation.dataComplete === false || observation.visibleOutputTokens === null || observation.toolMs === null) reasons.push('workload-data-incomplete');
  if (reasons.length) return { history: previous ? structuredClone(previous) : null, accepted: false, reasons };
  if (!Number.isSafeInteger(observation.requestCount) || observation.requestCount < 1) throw new TypeError('Invalid observed request count');
  nonnegative(observation.visibleOutputTokens!, 'visibleOutputTokens');
  nonnegative(observation.toolMs!, 'toolMs');
  if (observation.observedAtMs !== undefined) nonnegative(observation.observedAtMs, 'observedAtMs');
  if (previous && previous.kind !== observation.kind) throw new TypeError('Workload kind mismatch');
  const template = DEFAULT_TEMPLATES.find(template => template.kind === observation.kind);
  if (!template) throw new TypeError('Unknown workload kind');
  const center = (range: Span) => (range.low + range.high) / 2;
  const base = previous ?? { requestCount: center(template.requestCount), visibleOutputTokens: center(template.visibleOutputTokens), toolMs: center(template.toolMs), samples: 0 };
  return { history: { kind: observation.kind, requestCount: ewma(base.requestCount, observation.requestCount, alpha), visibleOutputTokens: ewma(base.visibleOutputTokens, observation.visibleOutputTokens!, alpha), toolMs: ewma(base.toolMs, observation.toolMs!, alpha), samples: base.samples + 1, lastObservedAtMs: observation.observedAtMs ?? null, sourceKind: 'local-measured' }, accepted: true, reasons: [] };
}
