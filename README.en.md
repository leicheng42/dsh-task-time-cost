# DSH task time and cost estimator

**A reference for the wait.** See remaining time, actual duration and cost references beside native Token statistics in DeepSeek Harness, calibrated to local routes without a separate estimator-model call.

[中文](README.md) · [Download stable](https://github.com/leicheng42/dsh-task-time-cost/releases/tag/v0.3.0) · [User guide](docs/public/guide.en.md) · [Report an issue](https://github.com/leicheng42/dsh-task-time-cost/issues/new/choose)

[![Stable](https://img.shields.io/github/v/release/leicheng42/dsh-task-time-cost?label=stable)](https://github.com/leicheng42/dsh-task-time-cost/releases) [![CI](https://github.com/leicheng42/dsh-task-time-cost/actions/workflows/ci.yml/badge.svg)](https://github.com/leicheng42/dsh-task-time-cost/actions/workflows/ci.yml) [![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<img src="docs/public/screenshots/summary-030.png" width="560" height="348" alt="Actual plugin showing a central ETA, the full reference range, forecast Tokens and reference costs" />

<details><summary>Dark theme</summary>

<img src="docs/public/screenshots/dark-030.png" width="560" height="374" alt="Actual dark theme with a complete time range and partial known cost notice" />

</details>

<details><summary>Completed turn duration</summary>

<img src="docs/public/screenshots/completed-030.png" width="560" height="250" alt="Naturally completed turn showing its actual duration, Tokens and public-reference cost" />

</details>

*Actual owned-component captures during 0.3.0 development on Windows / DSH Desktop 0.2.2-rc.2. Values belong to their capture-time tasks; prices are public references. These images are not accuracy benchmarks.*

## What it does

Version 0.3.0 provides these features:

- **Start with the project scope:** read ordinary requests and real Goal objectives; complete multi-app systems receive a project-scale initial reference, then a full-objective model plan can revise it.
- **Estimate the wait:** show a central time and the complete reference interval; sufficient comparable local tasks update the workload budget using their observed distribution.
- **See forecast Tokens:** observed Tokens, estimated remaining output and available total forecasts are separate. Less-used details and settings live under the header’s More (⋯) button.
- **Explain cost coverage:** known-model public list-price references with explicit overrides, without treating missing prices as free.
- **Learn locally:** route latency/speed, sources, samples and dates, plus JSON/CSV baselines and local statistics export.
- **Keep useful references:** retain the last valid time reference with its date when current planning is insufficient; bounded plans from the executing AI help estimate remaining work.

## Install

In DSH **Plugin Manager → Add plugin**, enter `dsh-task-time-cost@0.3.0` for the stable release. Both channels supply prebuilt files with no installation scripts.

```sh
dsh plugin --profile desktop add dsh-task-time-cost@0.3.0
```

Alternatively, install the pinned GitHub Release archive:

1. In DSH **Plugin Manager → Add plugin**, paste the archive URL below, or download it and select the local archive.
2. Enable **Task time and cost estimator** and restart when the Host asks.
3. Open the **clock beside Token statistics** for forecast Tokens. **More (⋯) → Settings and calibration** shows route samples.

```text
https://github.com/leicheng42/dsh-task-time-cost/releases/download/v0.3.0/dsh-task-time-cost-0.3.0.tgz
```

CLI (replace desktop with your profile):

```sh
dsh plugin --profile desktop add https://github.com/leicheng42/dsh-task-time-cost/releases/download/v0.3.0/dsh-task-time-cost-0.3.0.tgz
```

## Supported scope

**0.3.0: Windows / DSH Desktop 0.2.2-rc.2 / Node 24+.** Other environments remain unverified. See [compatibility](COMPATIBILITY.md) and [acceptance scope](docs/public/acceptance.md).

Time ranges are references, not promises or confidence intervals. Startup values are engineering priors. The release report separates chronological replay from actual process overhead. Online full-Goal error distributions and controlled provider comparisons are not established. Exact native running-line placement has no verified public seat; the entry is beside Tokens.

Prices are versioned list-price references or user rates, not subscription/relay invoices. Ambiguous reasoning/cache usage or incomplete future budgets stay unknown; currencies remain separate. Original price resolutions and initial forecasts are retained.

## Privacy and trust

No prompts, code bodies, tool arguments or credentials are saved by default. No statistics uploads, background price refresh or separate estimator call. Exports include configuration and route/session identities; review before sharing. [Privacy](docs/public/privacy.md)

Releases include SHA-256 and verification summaries. Follow Host restart requirements after updates. Keep diagnostics for repeated load failures instead of repeatedly reloading.

## Help improve it

[Report](https://github.com/leicheng42/dsh-task-time-cost/issues/new/choose) versions, steps and sanitized logs. Do not upload raw sessions or complete statistics exports. [Contributing](CONTRIBUTING.md)

An unofficial community plugin, not affiliated with DeepSeek. Public list-price references come from [models.dev](https://models.dev/). [Changes](CHANGELOG.md) · [MIT](LICENSE)
