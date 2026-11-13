# User guide

[Introduction](../../README.en.md) · [中文](guide.zh.md)

## Entry and estimates

Open the clock/estimate beside native Token statistics. The simple popup shows elapsed time, estimated total time, observed Tokens and estimated remaining output Tokens separately. A complete total Token forecast appears when known. The header’s More (⋯) button contains details and settings/calibration; reopening starts with the summary. Completed actions show elapsed time without duplicate Tokens. Retained time references carry a timestamp.

Very broad early ranges show “Refining estimate” in the entry while the dialog keeps the full computed range. At least 5 eligible completed tasks of the same kind and route can supply their central 20–80% workload distribution. Sparse samples retain engineering references. Executing-AI plans count model response rounds rather than tools or files; parallel tool time follows the critical path.

Complete normal tasks to collect local calibration. Profiles show route, source, date, samples and available metrics. Defaults of10s first text,80 visible tok/s,30s total call and0.5/2.5 reference factors are engineering priors, not provider measurements.

Provider, endpoint identity, model, mode, reasoning settings and tier distinguish routes. Unsupported endpoint identity remains unknown. Only configure a stable identity free of secrets, never an API key or credential-bearing URL.

## Costs and Tokens

Explicit rates win over bundled models.dev list-price references. Source/version are retained; list prices are not relay/subscription invoices. Complete means estimated under known usage/price semantics; partial retains a known subset, unpriced means insufficient evidence, and free requires explicit zero prices. Currencies stay separate.

Uncached input, cache reads/writes, output and reasoning follow verified semantics without double counting. A reported subtotal is not a complete total. Incomplete future budgets keep total forecasts unknown.

## Management

Read and edit full configuration before saving; fragments do not replace the complete document. Advanced JSON covers rates, route semantics and workload templates. Prediction refresh defaults to5000ms; the1000ms local display clock sends no RPC.

JSON/CSV baselines carry seedId, version, task/route scope, source, date, statistic, samples and ranges. Imports merge by identity and reject an invalid batch as a whole. Do not label means as quantiles or import an entire statistics export as baseline data.

Export preparation does not establish that a system Save dialog completed. Cancellation and an actually saved file are separate outcomes. Exports are not anonymous; review [privacy](privacy.md) before sharing.

Confirmed calibration reset advances the learning cutoff but retains historical usage/prices, configuration, imported baselines and DSH sessions. Uninstall retention depends on tested Host operations and options; it is not a backup substitute.

## Errors and updates

Missing/partial is not free or complete. The estimator does not stop tasks, switch models or declare completion. Storage faults produce diagnostics while the Host continues task execution.

After package replacement, follow the Host restart requirement. For failures, record version, Console and reproduction steps, without repeatedly reloading or modifying unrelated plugins. Test destructive controls with isolated data. Remove identities, secrets and message bodies before reporting.
