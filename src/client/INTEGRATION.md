# Client 对接与验证报告

范围：仅 `src/client`、`tests/client`。对应共享 task-2。业务 DTO 以 `src/shared/wire.ts` 为准，Client 不修改 DTO、Host 或根构建文件。

## 入口与封装

`src/client/index.tsx` 是普通 TSX 模块，导出：

```ts
export const inject = ['slots', 'locale', 'remote'];
export function applyClient(ctx: Context): void;
export const apply = applyClient;
```

lead 的 Client factory wrapper 必须先挂载 `remoteContribution`，再调用 `applyClient(ctx)`。唯一 Cordis 引用为真实 `@deepseek-ai/cordis` 的 `import type { Context }`；无包级 remote 读取，无 Harness Client 包运行时导入。Client factory 协议与包 id 由 lead 的 esbuild wrapper 处理。

在 apply 内读取 `ctx.get('remote').taskEstimator`、slots、locale。locale 注册 `task-estimate` 命名空间的 `zh` / `en`；界面随 locale revision 更新。注册：

| 槽 | id | order | 数据位置 |
|---|---|---:|---|
| `conversation.composer.dock` | `task-estimate` | 2 | `sessionId` 与 `useProjection('taskEstimator')` |
| `conversation.chat.turnTail` | `task-estimate` | 10 | `turn.turn` 与 `seq` |

投影业务值直接为 `{ revision: number, currentTurn: number | null } | undefined`。当前回合随 revision 立即刷新；历史尾部按明确 turn 读取，避免每个新事件刷新所有历史回合。

## RPC

所有请求处理外层 `RemoteResult`；管理请求还检查内层 `ManagementResult.ok`。Host 拒绝保留 code/message，网络异常、业务错误、15 秒超时均可见并可重试。卸载或取消会 abort，请求晚到不会覆盖新状态。

| 方法 / action | payload / 参数 | 结果处理 |
|---|---|---|
| `snapshot(sessionId, turn, signal)` | session id、明确 turn 或 null | 检查 RemoteResult、EstimatorView.error、snapshot.error |
| `manage('read', '', signal)` | 空字符串 | data.config / history / ProfileSummary[] / diagnostics / storage |
| `manage('saveConfig', json, signal)` | 完整配置 JSON 字符串 | 本地对象/有限数字检查，完整业务校验由 Host 执行 |
| `manage('importBaselines', content, signal)` | JSON 或 CSV 原文 | Host 识别格式，界面显示返回失败 |
| `manage('export', '', signal)` | 空字符串 | exported 字符串变为 JSON Blob 下载，组件释放 URL |
| `manage('resetCalibration', '', signal)` | 空字符串 | 用户先展开本地二次确认，再发 RPC |

重置提示与 Host 已确认：重置本地性能、工作量学习；保留任务历史、价表/配置、导入基准及 DSH 会话。

## 显示与生命周期

- dock 空闲时显示低干扰入口；运行时主行显示工作耗时、预计剩余、预计总费用；turnTail 显示结束状态、耗时及已记录费用。
- 缺价、partial、unavailable 明确说明无法完整估算；已知金额单列，不将局部费用当总额或上限。金额直接格式化十进制字符串，不经过浮点数，不同币种分开。
- 展开包含 Token 分类/覆盖、性能与来源、样本、初始对照、原因及管理。推理/缓存分类不重复求和。常见 reason code 有中英文说明，未知 code 保留可见。
- 一个 SnapshotStore 共享 session/turn 请求、inflight 和轮询；运行/排队默认 5 秒轮询，等待用户/结束停止轮询；投影立即更新以覆盖短任务。
- 独立共享本地时钟默认 1 秒更新文字，不发 RPC。等待用户时冻结工作计时和剩余区间，单独累计暂停时间。重置所有 timer/subscription/AbortController 由组件或 Cordis effect 持有。
- 所有容器/控件继承字体，颜色只使用已核验 `--dsw-alias-*` tokens。原生 details/summary、带 label 的表单、键盘 focus、真实 pending/error、触屏较大点击区和 reduced-motion 支持均在真实槽组件中实现。

## 验证

2026-11-12：

1. `node --test tests/client/*.test.ts`：**21 passed, 0 failed**（最后一轮约 291ms）。
2. Client 入口与三个 test 文件的 scoped 严格 TypeScript 检查：**通过**。使用根 tsconfig 同等 target / NodeNext / strict / skipLibCheck / JSX React 参数，引用真实 Cordis Context，未改根配置。
3. esbuild `bundle:true, platform:'browser', format:'cjs', jsx:'transform', external:['react'], write:false`：**通过**。metafile 断言唯一外部依赖是 `react`；没有写构建产物。
4. 静态运行时 import 检查：只有 React；Cordis 仅 type import；没有 `any`、Harness Client 运行时依赖、预览 HTML、mock shell 或 React/DOM 仿真。

21 个测试覆盖：零值与 unknown、区间合法性、亚秒延迟、极小金额/大整数精度、多币种、缺价/partial 不假上限、暂停/结束本地计时、中英 key 一致性、配置 JSON 对象校验、RemoteResult 和业务双层失败、原文 payload、超时与 abort、无 message 时仍显示错误 code、共享请求、投影合并和短任务、首次晚到投影、5 秒运行轮询、卸载后过期响应保护、本地时钟不发网络请求与清理。

当前环境 Client Inspect 无页面响应；既有 browser control ENOENT。槽与 locale 使用 lead 已读取的精确合同，TurnLocation 与 locale ids 又由官方固定版本 npm 声明核对。**本报告不宣称真实页面视觉验证通过**。实际 factory 安装/槽渲染、明暗主题、窄屏、完整配置操作及下载交互由 lead 的真实宿主集成验证继续完成。
