# Usage Dashboard Replay Cache

[English](2026-11-14-usage-dashboard-replay-cache.md) | [简体中文](2026-11-14-usage-dashboard-replay-cache.zh-CN.md)

Status: implemented (PR #17239).

## Problem

The Web Shell Daemon Status "Usage" tab loads via `GET /usage/dashboard`, which
calls `loadUsageHistoryWithLive()`. Daemon / Web Shell sessions are never written
to the durable `usage_record.jsonl` (only the TUI `/clear` path persists usage),
so the dashboard reconstructs them by replaying session transcripts. The original
replay read every transcript in the trailing 35-day window and `JSON.parse`d every
line, including multi-megabyte `tool_result` payloads that contribute nothing to
usage. On a heavy history (~3000 transcripts, ~5.4 GB) a single load took ~80 s,
and the cost was paid again on every refresh once the route's 60 s cache expired.

## Goals

- Make repeat / refresh / period-toggle loads sub-second on a long-lived daemon.
- Reduce the one-time cold load after a daemon restart.
- Keep the dashboard read-only: opening it must never write to `~/.qwen`.
- Preserve the exact aggregated numbers (totals, per-model share, heatmap, daily
  charts) and the existing dedup order.

## Scope boundaries

- In scope: `packages/core/src/services/usageHistoryService.ts` (replay + cache),
  the `usage-stats` route test, and the Web Shell `DaemonStatusDialog` prefetch.
- Out of scope: persisting daemon session usage at session end; background warming
  at daemon startup; changing the local-`today` window semantics.

## Proposed solution

1. **Selective streaming scan.** `summarizeTranscriptFile` streams a transcript and
   `JSON.parse`s only the first record, lines that could carry telemetry
   (`"ui_telemetry"` is a necessary substring of every such record), and a small
   trailing line. Large tool-result payloads are skipped.
2. **Per-transcript replay cache.** An in-process `Map` keyed by transcript path
   stores `{ mtimeMs, size, summarized }`. On each load a candidate whose
   `mtimeMs`/`size` match the cached entry is served from the cache; only changed
   files are rescanned. Transcripts are append-only, so any growth changes the size
   and invalidates the entry. The map is replaced wholesale each load, pruning
   transcripts that aged out of the window or were deleted.
3. **Bounded concurrency.** The cold scan runs up to `REBUILD_CONCURRENCY = 8`
   workers. Summaries are keyed by path; a separate sequential pass dedups by
   `sessionId` in directory order, so the result is order-identical to a sequential
   scan.
4. **Trailing timestamp extraction.** The end timestamp comes from the trailing
   record. A small trailing line (<= `MAX_TRAILING_PARSE_CHARS = 64 * 1024`) is
   parsed for cheap `}{`-glued recovery. A larger trailing line is never
   `JSON.parse`d; `extractLastTopLevelTimestamp` walks it with a brace/string/escape
   state machine and accepts a `timestamp` only at depth 1 of the last top-level
   fragment, so a nested payload `timestamp` cannot hijack the record's own end time.
5. **Dialog prefetch.** `DaemonStatusDialog` fires a fire-and-forget
   `loadUsageDashboard({ range: 'today' })` on open (when the daemon is available and
   not connections-only) so the first click on the Usage tab is warm. The route
   coalesces it with the tab's own load; a rejection is swallowed.

## Design decisions and rationale

- **In-process cache, not on disk.** Keeps the "opening the dashboard never writes
  `~/.qwen`" invariant. The daemon is long-lived, so the cache is warm for the
  process lifetime; it is cold only after a restart.
- **Cache only the read-only live merge.** `useCache = !persist`; the one-time
  persisting migration and the pre-deletion salvage always rebuild from disk.
- **Rethrow read errors.** A failed scan (EMFILE/EACCES/EIO/EBUSY) is rethrown, not
  collapsed into the `null` returned for "no telemetry", so the worker's catch skips
  the cache write and the next load retries. Legitimate negatives (no telemetry /
  empty transcript) are still cached.
- **Depth-aware trailing timestamp.** Raw first/last-match extraction is not
  structure-aware: a nested `timestamp` in the payload appears after the record's
  own and would win. The depth-1 state machine accepts only top-level timestamps and
  never parses the large tail.

## Constraints

- Read-only: no write to `~/.qwen` on the dashboard path.
- Never `JSON.parse` a trailing line larger than 64 KiB (pinned by a test asserting
  the largest `JSON.parse` input stays < 10 000 chars).
- Preserve dedup order (first occurrence wins in directory order) and persisted-wins
  conflict resolution.

## Risks

- The cache is cold after a daemon restart; the first load still scans the window
  once (~37 s on the reference history, down from ~80 s).
- The mount-time prefetch pays the first cold replay even for operators who never
  open the Usage tab; it is fire-and-forget and coalesced, and every later open is
  cheap. (Recorded as a deferred trade-off.)

## Validation plan

- Unit tests: cache hit/invalidation/pruning, selective scan, glued/corrupt/large
  trailing tails, nested payload timestamp, concurrency bound, read-error recovery,
  and the real-route replay (multi-timezone, including the first seconds after local
  midnight). Each guard is mutation-witnessed.
- Real-environment E2E: real express route + real temp filesystem + real HTTP;
  cold/warm/growth/read-only and the large glued/nested tails.

## Acceptance criteria

- Repeat / refresh / period-toggle loads are sub-second on a warm daemon.
- Aggregated numbers are byte-identical to the previous full-parse replay on a
  frozen history.
- No write to `~/.qwen` on the dashboard path; a transient read error recovers on the
  next load.

## Open questions

- Whether to persist daemon session usage at session end (removes most replay) or
  warm the cache at daemon startup (removes the cold first load) — both out of scope.
