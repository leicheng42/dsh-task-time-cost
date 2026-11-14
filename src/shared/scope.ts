import type { Span, TaskKind } from './types.ts';
/** Coarse numeric scope only. The source objective is never retained. */
export type WorkloadScale = 'task' | 'project' | 'program';
export function mergeWorkloadScale(a: WorkloadScale = 'task', b: WorkloadScale = 'task'): WorkloadScale {
  return a === 'program' || b === 'program' ? 'program' : a === 'project' || b === 'project' ? 'project' : 'task';
}
export function inferWorkloadScale(prompt: string, kind?: TaskKind): WorkloadScale {
  if (kind === 'question' || kind === 'writing') return 'task';
  const text = prompt.slice(0, 32_000);
  if (/^\s*(?:解释|介绍|什么是|写.{0,8}(?:字|故事|文章)|explain\b|what\b|write\s+(?:a\s+)?(?:story|article))/iu.test(text)) return 'task';
  if (/(?:只|仅).{0,12}(?:一个按钮|一处|拼写|文案|颜色|typo|one button)/iu.test(text)) return 'task';
  const action = /实现|开发|交付|构建|复刻|做成|可运行|真正可用|build|implement|deliver/iu.test(text);
  const product = /完整.{0,12}(?:系统|项目|应用|产品)|可运行系统|全部功能|(?:complete|entire|full).{0,20}(?:system|application|product)|全栈|从零.{0,12}(?:系统|应用)|production.{0,12}(?:system|app)|full.stack/iu.test(text);
  const multiple = /四端|多端|多应用|multiple apps|multi.app|商户端.{0,80}(?:师傅|管理后台)|官网.{0,80}(?:App|后台)|four (?:apps|clients)|web.{0,100}mobile/isu.test(text);
  const integration = /真实\s*(?:API|后端)|共用.{0,20}(?:后端|数据)|业务闭环|实时聊天|real\s+(?:API|backend)|shared backend/iu.test(text);
  const acceptance = /E2E|端到端|像素|DoD|全部通过|全部满足|未达标不得停止|acceptance|end.to.end/iu.test(text);
  if (action && (multiple && (integration || acceptance) || product && integration && acceptance)) return 'program';
  if (action && (product || integration && acceptance)) return 'project';
  if (/(?:正式版|稳定版|插件|仓库).{0,48}(?:反复迭代|持续迭代|优化迭代|正式发布)|(?:反复迭代|持续迭代).{0,48}(?:发布|正式版|稳定版)/isu.test(text)) return 'project';
  return 'task';
}
/** Engineering assumptions for complete deliverables, not measured accuracy or time floors. */
export const SCOPE_BUDGETS: Readonly<Record<Exclude<WorkloadScale, 'task'>, { requestCount: Span; visibleOutputTokens: Span; toolMs: Span }>> = Object.freeze({
  project: { requestCount: { low: 50, high: 160 }, visibleOutputTokens: { low: 15_000, high: 80_000 }, toolMs: { low: 600_000, high: 3_600_000 } },
  program: { requestCount: { low: 160, high: 500 }, visibleOutputTokens: { low: 50_000, high: 250_000 }, toolMs: { low: 3_600_000, high: 21_600_000 } },
});
