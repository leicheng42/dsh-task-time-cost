# Compatibility / 兼容范围

| Area | Target or boundary |
| --- | --- |
| Candidate | 0.2.9-beta.1 public preview; original P0 incomplete |
| Host | Windows DSH Desktop 0.2.2-rc.2 |
| Runtime | Node 24+, Cordis 4.1.0, Typert 0.2.2-rc.2, aligned Zod 4.6.6 |
| Client | DSH module factory, one external Host React, public Slot contracts and theme tokens |
| Algorithm | p0-0.2.9; comparable workload distributions, current-turn records and optional session aggregates |
| Other environments | Other DSH releases, macOS/Linux, ACP and mobile unverified |

## Lifecycle / 生命周期

Package import, factory evaluation, Client apply, rendered UI, cold page boot and full process restart are distinct checks. Replacing an installed package requires the Host's normal restart to load a new JavaScript generation. Do not infer updated code from an unchanged slot id.

Native graph-stream failures and shared-batch404s have been observed. A later recovered page can demonstrate recovery and allow a new lifecycle test; it does not prove a Core fix. A failed old observation is retained alongside the successful retest, with its version and document scope.

精确原生运行状态行内 ETA 仍缺已核验的公开扩展槽；本插件不改写宿主 DOM 或修改核心。历史 UI、Console、保留及归档结果均不自动变成本版通过。

## Durable data / 持久数据

Streaming IDs are only Agent-lifecycle unique. Profile training uses committed session/sequence identities while raw attempt IDs, usage, initial estimates and original price resolutions are retained. Incremental projections and schema-validated real JSON storage are covered by regression tests.

Missing or ambiguous values remain unknown. Old derived summaries are refreshed from original facts when their sessions are loaded; an exporter version does not mean every historical record was migrated.

The current external report is authoritative for version, bytes, tests, lifecycle, screenshots and remaining gates. See [acceptance](docs/public/acceptance.md) and [privacy](docs/public/privacy.md).
