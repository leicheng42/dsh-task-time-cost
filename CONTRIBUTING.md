# Contributing / 贡献

Use Node24+ and the exact SDK versions in the lockfile. From the complete source checkout, run `npm ci`, `npm run check` and `npm run pack:check`. The runtime archive is not a complete test checkout.

Read [acceptance](docs/public/acceptance.md) before changing behavior. Inspect exact running Service/Event/Slot contracts before using SDK APIs. Keep Host facts, shared estimation and Client rendering separate; use public extension seats and retain caller-owned disposal. Do not modify DSH Core, other plugins or user credentials as an implementation shortcut.

Missing values are not zero. Final usage replaces streaming usage. Prices use fixed-point arithmetic; currencies stay separate. Preserve raw call identity, original price resolution and initial forecasts. Calibration deduplication uses committed session/sequence, not a cross-lifecycle stream id.

Add meaningful regressions for changed accounting, persistence or lifecycle behavior. Use actual Cordis/Gateway/JSON storage where relevant; synthetic fixtures and factory execution do not establish actual UI acceptance. UI styling inherits Host tokens and fonts. Keyboard, focus, narrow layout and reduced motion need actual verification.

Keep temporary profiles, raw exports, screenshots containing conversation content and diagnostics outside the public source/package. Publish only reviewed cropped real captures. Record test/evidence scope and retain failures. Do not relax acceptance gates or relabel old evidence to report completion.
