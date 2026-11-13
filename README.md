# DSH 任务耗时与费用预估

**让等待有个参考。** 在 DeepSeek Harness 的 Token 统计旁，查看剩余时间、实际用时和费用参考；预估随本地路由表现持续校准，无需另起估价模型。

[English](README.en.md) · [下载预览版](https://github.com/leicheng42/dsh-task-time-cost/releases/tag/v0.2.8-beta.2) · [使用指南](docs/public/guide.zh.md) · [反馈问题](https://github.com/leicheng42/dsh-task-time-cost/issues/new/choose)

[![Preview](https://img.shields.io/github/v/release/leicheng42/dsh-task-time-cost?include_prereleases&label=preview)](https://github.com/leicheng42/dsh-task-time-cost/releases) [![CI](https://github.com/leicheng42/dsh-task-time-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/leicheng42/dsh-task-time-cost/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![时间、工作量与费用参考示意图](docs/public/preview.svg)

## 它能帮你做什么

- **估计还要多久**：紧挨原生 Token 用量的简洁 ETA，点开看实际用时和预计总耗时。
- **看懂费用覆盖**：已知模型自动匹配公共目录参考价，自定义费率优先；缺价和部分已知金额明确区分。
- **留下本地经验**：按路由显示延迟、速度、来源、样本数和日期，支持 JSON/CSV 基线与本地统计导出。
- **长任务保留参考**：当前计划不足时可保留最后有效时间参考并标注更新时间；执行 AI 的有界计划用于换算剩余工作。

## 安装

在 DSH 的**插件管理 → 添加插件**中输入 `dsh-task-time-cost@beta` 安装预览版；两个分发渠道均提供预构建文件，无需运行安装脚本。

```sh
dsh plugin --profile desktop add dsh-task-time-cost@beta
```

也可从 GitHub Release 安装固定版本归档：

1. 打开 DSH 的**插件管理 → 添加插件**，粘贴下方归档地址；也可先下载归档，再选择本地文件安装。
2. 启用**任务耗时与费用预估**，按宿主提示重启。
3. 在会话底部 **Token 统计旁点击时钟**；从**设置与校准**查看本地路由数据。

```text
https://github.com/leicheng42/dsh-task-time-cost/releases/download/v0.2.8-beta.2/dsh-task-time-cost-0.2.8-beta.2.tgz
```

CLI（将 desktop 换成你的实际 profile）：

```sh
dsh plugin --profile desktop add https://github.com/leicheng42/dsh-task-time-cost/releases/download/v0.2.8-beta.2/dsh-task-time-cost-0.2.8-beta.2.tgz
```

## 预览版适用范围

**0.2.8-beta.2：Windows / DSH Desktop 0.2.2-rc.2 / Node 24+。** 当前支持范围内提供试用；其他平台和宿主版本未验证。[兼容记录](COMPATIBILITY.md)与[验收标准](docs/public/acceptance.md)保留未完成项。

时间范围是参考，不是完成承诺或统计置信区间。默认性能基线是工程起点；完整在线整任务准确率、供应商对比和观察开销尚未测量。精确“深度求索中，用时…”旁的位置缺公开扩展槽，目前入口位于 Token 旁。

费用使用带版本的公共目录或用户费率，不代表订阅或中转渠道账单。隐藏推理、缓存语义或未来预算不完整时保留未知；不同币种分开。旧价格版本和初始预测保留。

## 隐私与信任

默认不保存提示词、代码正文、工具参数或凭证，不上传统计，不后台联网更新价格，也不另起估价模型请求。导出包含配置与路由/会话身份，分享前请检查。[隐私说明](docs/public/privacy.md)

每个 Release 附 SHA-256 与验证摘要。更新包后按宿主提示重启；出现反复加载错误时保留诊断，避免连续刷新。

## 一起改进

欢迎通过 [Issue](https://github.com/leicheng42/dsh-task-time-cost/issues/new/choose)提供宿主/插件版本、重现步骤和已去除秘密的日志。不要上传原始会话或完整统计导出。[贡献指南](CONTRIBUTING.md)

本项目是社区插件，与 DeepSeek 无官方隶属关系。公共价格参考来自 [models.dev](https://models.dev/)。[发行说明](CHANGELOG.md) · [MIT 许可](LICENSE)
