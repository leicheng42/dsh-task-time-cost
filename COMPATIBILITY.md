# Compatibility / 兼容范围

## Version and platform policy / 版本与平台

| Area | Supported line or verification boundary |
| --- | --- |
| Plugin | 0.3.1 compatibility update; 0.3.0 remains immutable |
| DSH admission | `>=0.2.2-rc.1 <0.3.0-0` — rc.1, rc.2, rc.3 and compatible 0.2.x patches; excludes older APIs and every 0.3 prerelease/release |
| Protocol peer | The same API range; Cordis `~4.1.0`, Schemastery `~3.19.0` |
| Node Host | Node 24+; Windows (`win32`), macOS (`darwin`), Linux (`linux`, including WSL Hosts) |
| SDK matrix | Exact official SDK rc.1 / rc.2 / rc.3 on each of Windows, macOS and Linux; an additional Linux / rc.3 / Node 26 row |
| Artifact | One prebuilt archive from the baseline build is imported and installed by every matrix row, with file-by-file equality and removal checks |
| Browser Client | Shared DSH Web/Electron Client factory, Host React, public Slots and theme tokens; no native OS module |
| Algorithm / storage | `p0-0.3.0-goal3`, projection stateVersion5; usage, initial forecasts and historical prices unchanged |

The CI workflow defines the matrix above. Check its results and the release's compatibility report for the actual completed run, Node versions and CPU architectures. A version range is an API compatibility policy, not a claim that every future patch or architecture was already tested. DSH 0.2.1 and earlier, 0.3+, mobile/ACP-only UI and other operating systems are outside this release's support policy.

## What each check establishes / 验证层次

- Strict types and regression tests run against coherent official SDK versions. rc.1 uses its Zod4.4.3; rc.2/rc.3 use Zod4.6.6. Tests exercise real Cordis/Gateway and JSON Domain storage, including paths containing spaces and Unicode.
- Each real SDK CLI installs the same prebuilt archive in a separate profile, checks actual admission without exemptions, imports its configuration schema, compares every installed file and removes the plugin while preserving the base composition. Host import and Client factory evaluation are separate checks.
- Windows Desktop has actual UI observations. macOS/Linux runner tests establish code, storage, SDK and installer behavior; they do not establish a native Desktop pixel/keyboard/window-drag acceptance test. The older screenshots retain their capture version.
- macOS custom popovers explicitly mark their visible rectangle with `data-window-drag-exclude`, following the DSH migration contract. The body portal wrapper itself has no rectangle and is not used as the exclusion owner.
- WSL is a Linux Host for admission. Linux admission does not imply Windows interoperation or a graphical desktop. Browser Client OS does not determine the Node Host's platform.

## Lifecycle and retained data / 生命周期与数据

Package import, Client factory, Client apply, rendered UI, cold page boot and full process restart are distinct observations. Follow the Host's normal update/restart requirements; an unchanged slot id does not prove updated code. No version exemption is needed or recommended for a matching supported version.

This update changes compatibility metadata and a Client window-region attribute; it does not change storage schema, pricing rules or the estimator algorithm. Canonical committed session/sequence identities remain the training keys, while original usage, initial estimates and original price resolutions remain retained. Missing and ambiguous values remain unknown. An exporter version does not mean every historical record was migrated.

The original design allows `conversation.composer.dock` when no verified native running-line suffix exists. The plugin uses that public seat and does not rewrite native text or Host DOM. Earlier shared-batch and graph-stream Core failures are retained as scoped observations, not claimed fixed here.

See [acceptance](docs/public/acceptance.md) and [privacy](docs/public/privacy.md). Time references are not calibrated confidence intervals or delivery guarantees; public catalog prices are not provider invoices.
