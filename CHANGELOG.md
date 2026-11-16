# Changelog / 发行说明

## 0.3.3 — timeline and per-dimension progress

- Replace the range gauge with a real timeline: the bar runs from the task start to the latest predicted finish, fills the elapsed part, keeps the unspent uncertainty as a lighter band, and marks the central estimate.
- Give each dimension the same progress bar (spent against spent plus the upper remaining bound) with the share printed beside it; an unknown remainder is drawn as a dashed track rather than an empty or full bar.
- Print the shared date once in a completion range that crosses midnight, and stop repeating a forecast total that is identical to the remaining value.
- Tests and the release report keep the earlier scope split: only what was re-observed on this version is marked passed.

## 0.3.2 — one shape for time, Tokens and cost

- Answer the planning question first: the panel states the remaining time, the expected completion clock and the elapsed time, and the composer entry repeats the clock (`约 1m · 22:15`).
- Replace the metric cards with one table: rows are time, Tokens and cost, columns are spent / left / forecast total. Spent is a fact, left and total are forecasts, and an unknown value prints a dash instead of zero.
- Derive the remaining cost only when spending is complete and the forecast is complete; otherwise the cell stays unknown. Displayed amounts are rounded, the ledger keeps every decimal.
- Do not print a number before there is a basis: a task with no executing-agent plan and no local sample shows "assessing the task" instead of a reference prior. The system prompt now asks for the plan before the first substantive reply.
- A retained stale reference no longer prints an old total beside a much larger elapsed time.

## 0.3.1 — compatibility update

- Redesign the summary dialog around one question: a large central remaining time, a gauge showing the full reference range with both bounds, then compact cards for elapsed time, total, Tokens and cost. Unknown rows are dropped, a repeated range is merged, and the former stack of explanatory paragraphs becomes one line; exact amounts and full evidence stay in details. Summary cost is rounded to a readable amount while the ledger keeps every decimal.
- Retry a failed or empty first read a few times after a remount, so the row never stays blank, and show the last completed turn's duration instead of a placeholder title.
- Replace exact rc.2 Host and protocol-peer pins with the reviewed `>=0.2.2-rc.1 <0.3.0-0` API line; exclude older APIs and the next minor, including its prereleases. No version exemptions.
- Declare Windows, macOS and Linux Hosts; use portable Node/browser facilities and exercise Unicode/space storage paths.
- Mark the visible custom popover as a macOS window-drag exclusion, following the DSH migration contract.
- Add SDK rc.1/rc.2/rc.3 and three-OS CI plus Node26 coverage, and install the same baseline prebuilt archive through each actual SDK CLI. Separate native Desktop observations from SDK/installer evidence.
- Estimator algorithm, data schema, usage, original forecasts and historical price rules remain unchanged.

## 0.3.0 — 2026-11-14

- Reconstruct engineering scope from the official `goal/change` event before the first Agent turn and retain it through goal-sourced continuation messages. Store coarse scope metadata without objective text.
- Separate small tasks, complete projects and multi-app systems for the first engineering reference. Complete systems no longer inherit a seconds-scale generic task budget; clearly label the initial reference and preserve its full interval.
- Preserve small finishing plans on a continued Goal with observed prior work; an objective edit resets that exception.
- Distinguish `whole_goal` from `current_turn` model plans and reject implausibly small initial plans for substantial engineering scope. Require planning as the first work tool and include integration, verification and delivery.
- Restore numeric central ETA references, preserve them in Client caches and retained details, and keep invalidated follow-up forecasts out of current token/cost budgets. Use expected request durations along serial chains so infrequent long waits are retained.
- Wrap claiming question/approval answerers before their waterfall handlers, so human waiting pauses active time. Recover built-in blocking-question intervals after Host remounts, merge overlapping pauses once, and exclude them from tool work; no question content is retained.
- Record bounded actual Host observer, dispatch, snapshot and flush timings without identifiers or content. Report measurements and their limitations separately from accuracy claims.
- Algorithm `p0-0.3.0-goal3`; original initial predictions, usage and historical price resolutions remain unchanged. Artifact checks and actual observations are recorded separately in the release report.

## 0.2.9-beta.1 — narrower evidence-based budgets and simpler details

- With enough eligible completed tasks of the same kind and route, workload ranges use the observed central 20–80% distribution instead of preserving the wide template ratio. Future, reset, ineligible and other-route tasks are excluded; sparse data retains reference priors.
- Broad early ETA references read “Refining estimate” in the compact entry; the dialog retains the full calculated range and explains the uncertainty. No clipping or fabricated precision.
- The first popup shows observed Tokens and estimated remaining output Tokens separately. Already generated output is subtracted once from the remaining budget; incomplete full totals stay unknown.
- Move estimate details and settings/calibration under the header’s accessible More button. Closing and reopening returns to the simple summary; management still opens only on demand.
- Clarify executing-AI plans: count model response rounds rather than individual tool calls, and use parallel tool wall time. No extra estimator model requests.
- Algorithm p0-0.2.9; original usage, historical price resolutions and initial forecasts remain preserved. Original P0 and whole-task accuracy requirements remain open; this is a preview.

## 0.2.8-beta.2 — npm preview distribution

- Enables public npm publication with the beta tag and adds direct DSH installation instructions.
- Keeps the frozen GitHub beta.1 intact; runtime estimation, prices and algorithm p0-0.2.4 are unchanged.

## 0.2.8-beta.1 — public preview

- Adds public repository/support metadata, pinned prebuilt installation instructions, bilingual single-image details and an original transparent icon.
- Adds Windows CI and a sanitized bug-report template; retains known compatibility/acceptance limits.
- Runtime estimation, pricing parameters and algorithm p0-0.2.4 are unchanged from0.2.7.

## 0.2.7 — prepublication candidate

- Separate public user material from internal development notes; narrow the archive whitelist and check packed documents for machine-specific narratives.
- Replace stale cross-version acceptance claims with explicitly scoped current reports.
- Focus invalid configuration JSON or numeric controls, preserve their drafts, and give management fields stable names with autocomplete disabled.
- Clarify engineering baseline provenance versus the separately bundled public price catalog.
- Preserve pricing/model parameters, original usage, historical valuations and algorithm p0-0.2.4. Current UI and data checks remain independently recorded; P0 is incomplete and nothing is publicly published.

## Earlier local candidates

- 0.2.6 fixed cross-Agent-lifecycle calibration deduplication using committed call identities, with real JSON reopen/raw-record preservation regression and197 passing tests.
- 0.2.5 bounded expanded management panels using owned geometry and internal scrolling.
- 0.2.4 fixed initial keyboard focus, export-preparation feedback and optional session aggregates stripped by the remote schema.
- 0.2.3 added native-style composer placement, durable last-valid references and the public list-price catalog.
- 0.2.2 aligned the rc.2 SDK and added bounded plans from the executing AI.
- 0.1.0 was withdrawn after a real Client boot failure and must not be installed. Later candidates fixed independent namespace access and configuration ownership; earlier evidence keeps its original scope.
