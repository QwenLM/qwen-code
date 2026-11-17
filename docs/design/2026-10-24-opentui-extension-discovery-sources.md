# OpenTUI extension discovery and sources

[English](2026-10-24-opentui-extension-discovery-sources.md) | [简体中文](2026-10-24-opentui-extension-discovery-sources.zh-CN.md)

Implementation and validation evidence, including their scope and unresolved findings, are tracked in [PR #15671](https://github.com/QwenLM/qwen-code/pull/15671). The E1–E10 requirements below remain the final acceptance gate.

## Problem and existing behavior

Before this batch, OpenTUI exposed Installed/Discover/Sources navigation but rendered honest unavailable placeholders for the last two. Installed already implements detail, enablement, favorites, scope, update and uninstall; preserve it. Ink implements both missing tabs with existing ExtensionManager, SourceRegistryStore, local marketplace parsing, persistent marketplaces.json, scoped installation and capability consent. Merely drawing new tab contents would leave source configuration, permission handling and disk state disconnected.

The pre-batch native dialog mount supplied Installed rows/actions only. Ink AppContainer installs consent, setting and marketplace-choice handlers; no equivalent native acquisition handler was established by the audit. Core's default consent callback resolves, so a new acquisition path must never assume that default establishes interactive consent.

## Goals and boundaries

Deliver one complete source-to-installed flow: configure/browse a marketplace, discover/filter/select plugins, choose user/project scope, review real capabilities and required settings, cancel or install, report committed warnings, refresh all three tabs, and reopen persisted state. Include source details/update/removal and direct extension-source install. Match Ink keyboard semantics and truthful outcomes. Keep existing Installed actions and shared installer/security/persistence behavior.

No new registry, backend installer, dependency upgrade, marketplace framework, global mutable dialog callback, or automatic approval. No tab-only partial PR. No claim that source fetch physically cancels when its API lacks a signal. Existing npm/standalone/runtime acceptance remains separate.

## Reused services and UI

| Layer          | Existing entry and responsibility                                                                                                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source catalog | ExtensionManager.getSources/addSource/removeSource/markSourceUpdated/loadSource/discoverPlugins; SourceRegistryStore persists marketplaces.json and invalidates existing discover cache             |
| Source parsing | extension/marketplace.ts parseInstallSource and loadMarketplaceConfigFromSource; sourceRegistry.ts constructs legal install sources and sanitizes display metadata                                  |
| Installation   | ExtensionManager.installExtension(metadata, consent, setting, cwd, previousConfig, activation, signal), its actual prepare/commit path, symlink/trust/network policy and committed-warning identity |
| Permission UI  | commands/extensions/consent.ts requestConsentOrFail plus existing action-modal signal/isCurrent; native text/secret setting and marketplace-choice views must be connected completely               |
| Native chrome  | dialogs-extensions existing tabs, list windows, detail and scope primitives; dialog mount owns async state and existing Installed row rebuild                                                       |
| Ink authority  | DiscoverTab/SourcesTab and ExtensionsManagerDialog define search, batch/detail retry, filter, locked view, status and footer semantics                                                              |

Use direct defining-module core imports and type-only imports where appropriate. Do not import Ink Box/Text or an Ink component subtree into OpenTUI. Share only small pure helpers when exact reuse reduces duplication.

## User flows and persistence

Sources shows direct-install, add-marketplace and configured-source entries. Add accepts a real marketplace; a single extension produces the existing actionable install guidance. The list preserves each source type while shortening the path to its column. Detail loads config and installed preview and wraps the complete redacted path in a bounded scroll region; PageUp/PageDown make overflow accessible while preserving action space. Browse opens Discover with a sanitized marketplace filter. The R key refetches the source view without changing lastUpdatedAt; the explicit Update action advances it only after a real non-null load. Remove has a real confirmation and removes the source, not installed artifacts. Persistence errors appear as errors without tearing down the TUI.

Discover provides query/filter, cursor/window, multi-select of uninstalled entries, detail and user/project scope. Typable j/k stay query characters in Discover as in Ink; Sources uses them for navigation. Batch partial failures preserve each actual outcome, clear the selection and return to the list as Ink does; retry requires explicit reselection rather than an automatic retry of stale items. Detail supports only safe http(s) homepages. Tab clears an active marketplace filter before switching.

Discover installation uses its real user/project scope picker. Direct Sources installation retains Ink's default user scope. Installation passes explicit per-operation consent/settings callbacks, target directory and activation. User uses {scope:'user'}; project uses {scope:'workspace',workspacePath:capturedTarget}. Consent shows real commands, skills, agents, workflows and changes through the existing helper. Settings preserve sensitivity and cancel rejection; plugin choice preserves Ink’s immediate 1–9 shortcuts even for larger catalogs; marketplace choice returns a real selected plugin or cancellation. Never provide an empty default, bypass trust, or execute a substitute installer. The manager has no operation-local plugin-choice parameter: after a real Claude marketplace parse returns marketplaceConfig without pluginName, a current owned CLI choice must select and validate a unique actual plugin, then populate the existing metadata.pluginName before installation. The installer still loads and validates the final source again and requests consent for that actual content; the preview is not permission to install changed content. Do not replace the shared manager choice handler or add a core callback port.

After commit, real success and committed-with-warnings are distinguished from failure. Failure of a later scope preference or reload must not label a committed artifact as absent. Refresh loaded extensions and existing Installed rows, Discover installed flags, source preview and existing refresh-required state. Reopen reconstructs persisted truth; do not promise immediate command activation when the existing service requires reload.

## Ownership and cancellation contract

Capture dialog request identity, current Config/manager, session identity, target directory and one operation controller in the existing local owner. Every UI publication and confirmation resolution checks that owner. Close, session replacement and superseding operation invalidate it. Shared refresh completion carries its existing state’s monotonic revision, so loss of the UI owner still settles that transaction without ending a successor. Command loading checks captured Config/session/target before registry publication; disposed shells cannot publish their old command list, and a held startup request rechecks ownership before dispatching a newly loaded command. Do not replace a shared manager callback with a closure owned by a disappearing dialog.

| Actual call path                 | Cancellation and completion semantics                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| discoverPlugins / loadSource     | No caller AbortSignal currently. Ignore stale UI completion; do not claim cancelled network or undo a returned cache update                                  |
| addSource                        | Fetch then actual registry write; no signal. Closing suppresses stale UI, but an already committed source can remain on disk and must reappear on reopen     |
| removeSource / markSourceUpdated | Synchronous persisted mutation. Confirm before invocation; report write failure. No cancellation/rollback claim after write                                  |
| parseInstallSource               | No signal port. Recheck owner after await before starting installation; no physical parse/fetch cancellation claim                                           |
| consent / setting / choice       | Operation-local UI request; abort/owner change resolves denial or rejects, removes its own modal, never approves stale work                                  |
| installExtension                 | Pass actual signal; honor service-supported preparation/abort boundaries. Once commit occurs, retain committed outcome/warnings rather than pretend rollback |
| refreshCache / tab reload        | Rebuild real state and publish only to current owner; no second reload registry or stale status over a replacement dialog                                    |

Match Ink by locking outer tab/close actions while installation is pending; nested consent, setting and plugin-choice cancellation remains available and settles that operation. Session/request replacement and component unmount still abort owned work. Lock duplicate actions while pending. A completed mutation is not retried automatically after a late UI owner change. All acquired resources and modals must have finite teardown; tests observe natural CLI exit before forced cleanup.

## Planned changes and size

Likely changes: native Discover/Sources bodies, existing dialog mount/status/owner wiring, operation-local confirmation/settings/choice connections, focused shared pure helpers only if useful; collocated tests, one finite integration fixture/plan and this bilingual design. Existing Installed code is not reimplemented. The captured-target requirement needs a bounded change to existing source parsing: explicit cwd on the existing parser/loader and catalog operations, bound manager parsing that forwards its actual policy, stable absolute persistence for new local sources and cwd-aware reuse of the existing discovery cache. Native callers supply the captured root; existing callers without cwd retain their current behavior. Legacy relative sources are interpreted against the current captured root because their persisted schema has no original-root provenance. This is one feature batch with its live consumers and controls, not a new parser, registry or generic infrastructure PR. Physical cancellation of non-signal fetch is outside this change.

The original 1950–3100-line estimate was exceeded by the complete UI, lifecycle regressions and permanent three-leg acquisition test. One delivery PR must remain at or below 6000 additions plus deletions against its actual base, including tests and both design languages. Measure the formatted final diff before publishing or expanding it. Keep all unique controls; do not split new ports from their live consumers, delete tests, or move unrelated scope to meet the limit.

## Validation and acceptance

Follow the paired E2E plan. First record current global identity and finite observed behavior under owned HOME; an old release is not current Ink authority. Then actual B NodeInk/BunInk are controls and strict OpenTUI establishes the missing flow before implementation. No test reads real user credentials or modifies global config. Prefer legal owned local marketplace/extension fixtures over a network-policy bypass.

Acceptance gates E1–E10: E1 source add/detail/remove persisted; E2 discover/filter/search/multi-select and safe display; E3 user/project activation at captured target; E4 real consent/settings/choice deny/cancel/approve; E5 actual installation and committed warnings; E6 failure retry with no false updatedAt/success; E7 closed/replaced owner cannot approve or publish stale state; E8 cross-tab loaded/persisted truth and reload-required indication; E9 existing Installed controls unchanged; E10 finite identical renderer fixtures, raw evidence, natural exit and cleanup. All are pending.

Before shipping: actual own build/type/bundle, focused wholefiles, lint/format, relevant real product three legs, paired-doc audit and two consecutive clean full-diff audits. A green mocked manager test alone is not installation evidence. PR and E2E report must state platform/install limits.

## Open decisions and risks

Keep extension-owned consent, setting and marketplace choice within the mounted dialog body. The current shell renders an action modal instead of the dialog, which unmounts it; routing a mount-owned operation through that modal would invalidate its own owner and lose tab/batch state. Reuse the existing command-reload consumer chain after acquisition, without a new global handler or registry. Validate legal local marketplace syntax with actual service before global mutation. Implement the explicit-cwd path through the existing private source splitter; do not change process.cwd or duplicate URL/port/drive/plugin syntax. Verify ambient root A versus captured root B, relative source persistence/reopen and discovery cache identity with distinct real local bytes. Preview parsing must honor the actual core network policy. Current CLI Config constructs its manager without a networkPolicy, so default parser policy matches that caller; do not generalize this to managers with an explicit private policy or supply a permissive override. These are wired source-level contracts whose real installation and native behavior still require acceptance evidence. Define the observable result of close during non-abortable source persistence as committed-on-reopen, not fake cancellation. Keep the selected pending-close lock policy consistent across UI/footer/tests and do not change core trust policy to make fixtures green.
