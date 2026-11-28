# Capability-Gated Usage Stats and Context Usage Parity on Managed Sessions (Slice 5)

[English](2026-11-27-managed-usage-stats-and-context-parity.md) |
[简体中文](2026-11-27-managed-usage-stats-and-context-parity.zh-CN.md)

Status: implemented (Slice 5 of
[Unified Chat Surface](2026-11-16-unified-chat-surface.md)). Date: 2026-11-27.

## Problem

With all three chat columns (`ManagedSessionsPage`, `ChatPane`, and `App` main
chat) now rendering through the shared `ChatSurface`, two concrete
capability-gated disparities remained on Managed sessions even though the
Managed backend already provides the required facts:

1. **No under-composer usage reading (`ComposerUsageStats`).** The main daemon
   column renders `ComposerUsageStats` under the composer to show live output
   speed, total tokens, and cache hit rate, opening the usage panel on click.
   `ManagedAgentProvider.diagnostics.getStatistics` already serves
   `ManagedDiagnosticStats` with totals, token counts, known-usage counters,
   and generation timing, yet `ManagedSessionsPage` did not mount
   `ComposerUsageStats`.
2. **Context usage badge in `ChatEditor` had no detail opener on Managed.**
   `ManagedSessionsPage` passed `tokenCount`, `contextWindow`,
   `contextUsageKnown`, and `contextUsageControls` into `ChatEditor`, but
   omitted `onOpenContextUsage`, even though `ManagedDiagnosticsPanel` already
   renders the session's `context` breakdown.

## Goals

- Decouple `ComposerUsageStats` and `tokenUsageTotals` from daemon type imports
  via a backend-neutral structural `SessionUsageStatsSnapshot` type, and add
  optional `AbortSignal` forwarding and `cacheHitUnknown` support to
  `ComposerUsageStats` without breaking existing daemon callers.
- Add a pure, fail-closed adapter (`managedDiagnosticStatsToUsageSnapshot`)
  that projects `ManagedDiagnosticStats` into `SessionUsageStatsSnapshot`
  without fabricating turn counts or unknown token/cache-hit figures.
- Wire capability-gated `ComposerUsageStats` (in `ChatSurface.footerTrailing`)
  and `onOpenContextUsage` (in `ChatSurface.composerProps`) on
  `ManagedSessionsPage`, opening `ManagedDiagnosticsPanel` directly on the
  `'statistics'` or `'context'` tab via a new optional `initialTab` prop.

## Non-goals

- Adding conversation search or Goal controls to Managed sessions (neither has
  a Managed backend contract; deferred per the parent design).
- Changing Managed HTTP/SSE routes, OpenAPI schemas, storage keys, or i18n keys.
- Replacing `ManagedUserMessageQueue` with daemon `ComposerStatusStack`
  (Managed queues are backend-persisted records with distinct actions).
- Clearing the remaining transitive daemon value imports from
  `dist-managed-host` (Slice 6).

## Scope

- **`packages/web-shell/client/components/artifacts/tokenUsageTotals.ts`:**
  - Define backend-neutral structural types `SessionUsageGeneration`,
    `SessionUsageModelMetrics`, and `SessionUsageStatsSnapshot` (structurally
    compatible with `DaemonSessionStatsStatus`, plus optional
    `cacheHitUnknown?: boolean`), removing the
    `@qwen-code/web-shell/daemon-react-sdk` type import.
- **`packages/web-shell/client/components/ComposerUsageStats.tsx`:**
  - Type `loadStats` against `SessionUsageStatsSnapshot` with an optional
    second `signal?: AbortSignal` parameter, creating a per-request
    `AbortController` aborted on session switch or unmount.
  - Omit the cache-hit segment when `status.cacheHitUnknown` is `true` instead
    of displaying `0% cache hit` for providers that never report cached tokens.
- **`packages/web-shell/client/components/managed/managed-usage-stats.ts`:**
  - Pure adapter `managedDiagnosticStatsToUsageSnapshot(stats)`: - Returns an empty snapshot (`models: {}`) when `availability` is
    `'unsupported'` or `'not_recorded'`, `statistics` is `null`,
    `totals.requests.total <= 0`, or none of `usageKnown.{total, prompt,
candidates}` is positive. - Uses `statistics.totals` (covering all models including `overflow`, even
    when `modelBreakdownOmitted` is `true`), maps `timing.totalGenerationMs`
    and `timing.throughputOutputTokens` onto the legacy generation-window
    speed fields so `outputSpeed` matches `ManagedDiagnosticsPanel`'s exact
    formula, keeps `promptCount: 0` (never conflating LLM request count with
    user turns), and sets `cacheHitUnknown: totals.usageKnown.cached <= 0`.
- **`packages/web-shell/client/components/managed/ManagedDiagnosticsPanel.tsx`:**
  - Accept optional `initialTab?: ManagedDiagnosticsTab` (default `'context'`).
- **`packages/web-shell/client/components/managed/ManagedSessionsPage.tsx`:**
  - Gate `diagnosticsButton`, `onOpenContextUsage`, `ComposerUsageStats`, and
    `ManagedDiagnosticsPanel` on the single predicate
    `diagnosticsAvailable = Boolean(currentSummary?.capabilities.diagnostics && !detail.signals?.session && provider.diagnostics)`.
  - Render `ComposerUsageStats` in `ChatSurface.footerTrailing` when
    `diagnosticsAvailable && currentSummary`, forwarding `AbortSignal` to
    `provider.diagnostics.getStatistics` and opening `ManagedDiagnosticsPanel`
    on `'statistics'` on click.
  - Wire `onOpenContextUsage` in `composerProps` when `diagnosticsAvailable` to
    open `ManagedDiagnosticsPanel` on `'context'`.
  - Track the opening trigger element on `diagnosticsOwner` so closing the
    dialog restores focus to whichever control opened it.

## Key Design Decisions

1. **Read `statistics.totals` rather than summing `statistics.models`.**
   - Managed statistics cap the per-model list and may set
     `modelBreakdownOmitted: true` or populate `overflow`. Reading
     `statistics.totals` ensures the bar reflects full session usage even when
     per-model breakdown is truncated or omitted.
2. **Fail closed on unknown token and cache-hit metrics.**
   - `ManagedModelStatisticsBucket` tracks `usageKnown` per token field. When
     no request reported token counts, the adapter returns an empty model map
     so `ComposerUsageStats` stays hidden; when cached tokens were never
     reported (`usageKnown.cached <= 0`), `cacheHitUnknown: true` suppresses
     the cache-hit segment rather than misleadingly printing `0% cache hit`.
   - `promptCount` stays `0` because Managed statistics count LLM API requests
     rather than user prompts, so `ComposerUsageStats` omits the turns segment.
3. **Abort in-flight `loadStats` requests on session switch or unmount.**
   - Passing an optional `AbortSignal` from `ComposerUsageStats` preserves full
     backwards compatibility with daemon's 1-argument `loadComposerUsageStats`
     while letting `ManagedSessionsPage` cancel stale `getStatistics` HTTP
     reads immediately on session switch, permission loss, or unmount.

## Constraints

- `ComposerUsageStats` and `tokenUsageTotals` must hold zero imports from
  `daemon/**` or `@qwen-code/web-shell/daemon-react-sdk`.
- `build-artifact.test.ts` transcript-entry isolation (`keeps Token Usage copy
and lookups in the interactive entry only`) must remain green.
- No changes to Managed/Daemon HTTP/SSE routes, OpenAPI schemas, storage keys,
  or i18n keys.
- Strict capability gating: when `capabilities.diagnostics` is false/missing,
  `provider.diagnostics` is absent, or the session read has lost permission,
  neither `ComposerUsageStats` nor `onOpenContextUsage` is offered.

## Validation & Acceptance Criteria

- **Unit & integration tests:**
  - `managed-usage-stats.test.ts`, `ComposerUsageStats.test.tsx`,
    `ManagedDiagnosticsPanel.test.tsx`, `ManagedSessionsPage.test.tsx`,
    `ChatSurface.test.tsx`, `App.test.tsx`, and `build-artifact.test.ts` all
    pass.
  - New regression tests cover `managedDiagnosticStatsToUsageSnapshot` (all
    availability states, `usageKnown` guards, `cacheHitUnknown`, `overflow` /
    `modelBreakdownOmitted`, `promptCount === 0`, speed parity),
    `ComposerUsageStats` (`AbortSignal` abort on session switch/unmount and
    `cacheHitUnknown`), `ManagedDiagnosticsPanel` (`initialTab="statistics"`),
    and `ManagedSessionsPage` (capability gating, usage bar rendering, clicking
    usage bar → Statistics tab, clicking context ring → Context tab, and abort
    on session switch / permission loss).
- **Mutation witnesses:** Reachable new guards, capability gates, abort paths,
  and adapter branches verified red under an isolated mutation harness.
- **Static gates:** `tsconfig.lib.json`, `tsconfig.json`,
  `eslint --max-warnings=0`, `prettier --check`, and repository
  `npm run build && npm run typecheck`.
- **Real browser Before/After E2E:** Real local Vite + Chromium (`<StrictMode>`)
  mounting `<ManagedAgentWebShell>` Before (unmodified `origin/main`) vs After
  (Slice 5), verifying the capability-gated usage bar appears under the
  composer with real tokens/speed/cache-hit, clicking it opens Diagnostics on
  Statistics, clicking the context ring opens Diagnostics on Context, and zero
  page or unexpected console errors.
