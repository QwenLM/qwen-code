# Ledger-Backed Session Census and Daemon Session-End Usage Persistence

[简体中文](./2026-11-25-usage-ledger-session-census.zh-CN.md)

## Status

Implemented — verified locally across unit tests, full build/typecheck, and
real-process CLI/daemon/ACP end-to-end runs; follow-up to PR #17902
([Usage Dashboard and `/stats` Token Accounting](./2026-11-19-usage-dashboard-accounting.md)).

## Problem

PR #17902 aligned token, request, latency, and cache-read totals across the
daemon status Usage dashboard and TUI `/stats` with the per-request token
ledger (`token-usage-YYYY-MM.jsonl`). Two gaps were deliberately left as
follow-up:

1. **Record-only session counts underreport active sessions and can show
   `tokens > 0` with `sessions = 0`.** Both `buildUsageDashboard` (`summary.sessions`
   and `daily[i].sessions`) and `loadStatsData` (`report.sessionCount` and
   `delta.sessions`) still count only persisted/rebuilt `UsageSummaryRecord`
   rows. Sessions killed before exit, daemon sessions that never wrote
   `usage_record.jsonl`, and histories outside scanned project directories are
   present in the per-request ledger (for example, 633 sessions over seven days
   in the reference history) yet invisible to the session count. Conversely, a
   single conversation resumed three times wrote three run records and was
   counted as 3 sessions instead of 1.
2. **Daemon / ACP sessions never persist `usage_record.jsonl` at session end.**
   CLI runs persist run-scoped usage on exit and on `/clear` / `/resume` /
   `/branch` swaps, but `QwenAgent.removeStoredSessionEntry` in
   `packages/cli/src/acp-integration/acpAgent.ts` calls
   `uiTelemetryService.removeSession(sessionId)` without persisting the
   session's live counters. As a result, daemon / Web Shell sessions miss
   durable per-project, tool, file-change, duration, and skill metadata once
   closed, retired, or shut down, and force transcript replay on every
   dashboard refresh.

## Scope

- In scope:
  - Per-session live metrics and run-start clock in `UiTelemetryService`
    (excluding replayed and restored history, matching the process-wide
    `#liveMetrics` invariant from PR #17902).
  - Best-effort, at-most-once `runScoped: true` persistence when a daemon / ACP
    session is torn down via `removeStoredSessionEntry` (covering explicit
    close, idle retirement, and graceful daemon shutdown).
  - Ledger-backed distinct-session census (`countActiveSessions`) shared by
    `buildUsageDashboard` (`summary.sessions` and `daily[i].sessions`) and
    `loadStatsData` (`report.sessionCount` and both sides of `delta.sessions`).
  - Localized daily-sessions chart subtitle update across all Web Shell locales
    (`active sessions per day` instead of `runs ended per day`).
- Out of scope:
  - Changing `TokenUsageRecord` (`schemaVersion: 1`) or writing workspace paths
    into the per-request ledger. Preserving the path-privacy boundary is an
    explicit product decision; per-project / tool / file / skill breakdowns for
    daemon sessions are populated instead by persisting `usage_record.jsonl` at
    session end.
  - Changing `aggregateUsage` in `usageHistoryService.ts`, which remains a pure
    record-level aggregator.

## Design

### 1. Per-Session Live Telemetry & Daemon Session-End Persistence

`UiTelemetryService` currently tracks `#sessionMetrics` per `sessionId`, but
that map includes historical events fed through `addReplayedEvent` and
`restoreSessionModelMetrics`. Persisting `#sessionMetrics` directly on daemon
session close would re-introduce the resumed-history double-billing bug fixed
in PR #17902.

- Add `#sessionLiveMetrics: Map<string, SessionMetrics>` and
  `#sessionRunStartTimes: Map<string, Date>` to `UiTelemetryService`.
- Accumulate into `#sessionLiveMetrics` only on live `addEvent(event, sessionId)`
  and `recordSkillInvocation(skillName, success, sessionId)` (never on
  `addReplayedEvent` or `restoreSessionModelMetrics`), lazily recording
  `new Date()` in `#sessionRunStartTimes` on the first live activity for that
  `sessionId`.
- Pass no `sessionId` argument when accumulating into `#sessionLiveMetrics`
  (matching `#liveMetrics`) so persistence buckets do not allocate display-only
  `statsModels`, `invocations`, or `timingSamples`.
- Expose `getLiveMetricsForSession(sessionId): SessionMetrics | undefined` and
  `getRunStartTimeForSession(sessionId): Date | undefined`.
- Synchronize `#sessionLiveMetrics` and `#sessionRunStartTimes` across
  `snapshotForReplay`, `restoreFromReplaySnapshot`, `reset`, `resetSession`,
  and `removeSession`.
- Add `persistSessionUsageOnClose(config, sessionId)` to
  `packages/cli/src/utils/usage-persistence.ts`: reads the session's live
  metrics and run-start clock, skips when `!hasRunActivity(metrics)` (so
  resumed sessions closed without new activity write nothing), clamps
  `endTime = new Date(Math.max(startTime.getTime(), Date.now()))`, and writes a
  `runScoped: true` record via `persistSessionUsage`.
- Invoke `persistSessionUsageOnClose(session.getConfig(), sessionId)` in
  `QwenAgent.removeStoredSessionEntry` immediately before
  `uiTelemetryService.removeSession(sessionId)`. Because
  `removeStoredSessionEntry` guards `this.sessions.get(sessionId) !== session`
  and `removeSession` deletes the live bucket right after, each session's live
  spend is persisted at most once, best-effort, without blocking teardown.

### 2. Ledger-Backed Distinct-Session Census

`loadTokenUsageDailyByModel` already populates per-day, per-model `sessionId`
sets in memory (`getTokenUsageSessionIds`), and `deduplicateScopedLedgers`
preserves deduplicated per-scope overrides (`getLedgerSessionIds`). No extra
disk scan is required.

- Define `countActiveSessions(records, startKey, endKey, ledgerDaily?, runtimeScopes?)`
  in `packages/core/src/services/usage-dashboard-service.ts`:
  - Collect distinct non-empty `sessionId` values from:
    1. All `records` with `transcriptSupplement !== true` whose local end day
       `localDateKey(record.timestamp)` falls in `[startKey, endKey]`.
    2. All `getLedgerSessionIds(ledger, day, model)` entries for
       `day ∈ [startKey, endKey]` across `runtimeScopes` (when supplied) or
       `ledgerDaily`.
  - Return the union size.
- Use `countActiveSessions` for:
  - `buildUsageDashboard` `summary.sessions` (using `endedRecords`,
    `rangeStartKey`, `todayKey`, `ledgerDaily`, `runtimeScopes`);
  - `buildDaily` per-day `sessions` (per-day union of `endedRecords` ending on
    that day and ledger `sessionId`s on that day);
  - `loadStatsData` `report.sessionCount` over `[currentStartKey, currentEndKey]`,
    and both `currentDeltaReport.sessionCount` and `previousReport.sessionCount`
    over their respective completed local-day windows so `delta.sessions`
    compares identical distinct-session definitions on both sides, including
    windows backed solely by the ledger.
- Update the Web Shell daily-sessions subtitle (`daemon.usage.dailySessionsSub`)
  across `en`, `zh-CN`, `zh-TW`, and `ru` to reflect active sessions per day.

## Constraints and Invariants

- **No replay inflation on daemon close.** A resumed daemon session closed with
  zero new live activity persists nothing; a resumed session with one new live
  request persists only that request.
- **No `tokens > 0, sessions = 0` under ledger coverage.** Any day or window
  containing ledger records with a `sessionId` reports at least 1 active
  session, even when `usage_record.jsonl` has no entry for those runs.
- **Distinct-session monotonicity and deduplication.** Multiple runs of the
  same `sessionId` within a window (or presence in both the ledger and
  `usage_record.jsonl`, or across multiple runtime roots) count as 1 session.
- **Future-ended runs keep read-clock boundary.** Future-ended records
  (`timestamp > now`) remain excluded from `endedRecords`, while any real API
  responses already written to the ledger on `today` still register their
  `sessionId` as active.
- **Zero ledger schema change.** `token-usage-YYYY-MM.jsonl` stays at
  `schemaVersion: 1` with no project path field added.

## Acceptance Criteria

1. Closing, retiring, or gracefully shutting down an ACP / daemon session with
   live activity writes exactly one `runScoped: true` record containing only
   that session's live delta (tokens, tools, files, skills, execution IDs), and
   closing a resumed session with no live activity writes zero records.
   **Verified** by `uiTelemetry.test.ts`, `usage-persistence.test.ts`,
   `acpAgent.test.ts` close-wiring test, and a real `node dist/cli.js --acp`
   lifecycle (`300/300` tokens parity with ledger, idle `session/load` + close
   wrote 0 extra records, exit 0).
2. `buildUsageDashboard` `summary.sessions` and `daily[i].sessions` count
   distinct active `sessionId`s across ledger entries and ended non-supplement
   records; ledger-only days report their exact distinct ledger session count
   instead of `0`. **Verified** by `usage-dashboard-service.test.ts` (96/96)
   and real `qwen serve` `/usage/dashboard` runs (same session resumed twice
   deduplicated to `sessions: 1`; ledger-only history with `usage_record.jsonl`
   and transcripts deleted reported `sessions: 1` and `daily[today].sessions: 1`).
3. `loadStatsData` `report.sessionCount` and `delta.sessions` use the same
   distinct-session census, including when a comparison window is covered only
   by the ledger. **Verified** by `statsDataService.test.ts` (44/44) and
   `statsDataService.history.test.ts` (10/10).
4. All Web Shell locales render the updated `active sessions per day` subtitle
   and pass per-locale rendering tests. **Verified** by
   `UsageDashboardTab.test.tsx` (13/13 across `en`, `zh-CN`, `zh-TW`, and `ru`).
5. Verified by unit tests across `packages/core`, `packages/cli`, and
   `packages/web-shell`, full workspace `npm run build`, `npm run typecheck`,
   `npm run bundle`, ESLint, Prettier, and local real-process verification on
   the built CLI, daemon, and ACP runtime.
