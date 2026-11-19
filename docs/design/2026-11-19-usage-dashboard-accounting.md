# Usage Dashboard Accounting

[English](2026-11-19-usage-dashboard-accounting.md) | [简体中文](2026-11-19-usage-dashboard-accounting.zh-CN.md)

Status: Option A implemented. Defect 1 is fixed outright; defects 2 and 3 are fixed
for the dashboard wherever the per-request ledger covers the day. Defects 4 and 5
remain open, and the persist-side cause of defect 2 is unchanged.

## Problem

The Web Shell Daemon Status "Usage" tab overstates token consumption. Measured on
one real heavy history on 2026-11-18 (local), against the per-request ledger
`~/.qwen/usage/token-usage-YYYY-MM.jsonl` as the oracle:

| Window  | Dashboard       | Per-request ledger | Ratio |
| ------- | --------------- | ------------------ | ----- |
| Today   | 1,690,741,563   | 851,107,656        | ~2.0x |
| 7 days  | 67,264,675,464  | 13,030,723,769     | ~5.2x |
| 30 days | 301,992,859,495 | 43,099,928,198     | ~7.0x |

The two columns were captured minutes apart on a live machine, so the ratios are
approximate; the per-session reconciliation below is exact. History shape: 2,060
persisted records, 3,877 merged records, 76,849 project directories, ~12 GB of
transcripts, 770,906 ledger lines (~291 MB).

Five independent defects produce the gap.

1. **Reasoning billed twice (fixed).** The output tile rendered
   `summary.outputTokens + summary.thoughtsTokens`, but chat-completions providers
   already include reasoning in the output count. Today's tile read 7,208,898
   against a provider output of 4,952,378 (+45.6%), and input + output did not sum
   to the hero total.

2. **Resumed history persisted as new usage (dashboard side fixed).**
   `persistSessionUsage` writes `uiTelemetryService.getMetrics()`, which a
   session-swap replay has already filled with the resumed conversation's whole
   history. Session `4669c795-e9bc-4ae7-9a1e-1c75795cf446` covers a 7-minute window
   (01:04:23 -> 01:11:54) yet carries 45,679,298 tokens across 506 requests, and its
   per-model totals are identical to the full-history telemetry of transcript
   `df2ad8ce-e86d-49f5-80c7-6012e8736660` (6,682,231 / 5,209,415 / 30,559,974 for
   `qwen3.8-max-preview` / `gpt-6-astra` / `glm-5.3`). Every resume of that
   conversation appends another full copy. This is the dominant term. The records
   are still written this way; the dashboard no longer reads their tokens for a day
   the ledger covers.

3. **Windows attributed by session end (fixed where the ledger covers).**
   `aggregateUsage` filters on `r.timestamp` (the session's last record) and the
   daily/heatmap builders bucket on the same value, so a session's entire spend
   lands on the day it last ran. Session `864fc39f-956e-48ce-810d-231d9e2f82aa`
   contributed 335,062,436 to "today" while its events bucket to 126,738,776
   (11-15), 207,250,267 (11-16) and 1,073,393 (11-18). Seven of today's 42 sessions
   started on earlier days and carried 818,260,710 tokens (48.4% of the displayed
   total).

4. **One run counted twice under two session ids (open).** A transcript is named by
   `chatRecordingService`'s `binding?.sessionId ?? pinnedSessionId ??
config.getSessionId()`, while `persistSessionUsage` keys on
   `config.getSessionId()`. Only 1 of 189 transcripts touched in the trailing two
   days had an id present in the persisted set, so both `skipSessionIds` and
   `dedupBySessionId` miss. Matching a persisted record whose end time is within
   2 s of the transcript's last record, same project, replay tokens <= persisted
   tokens: 2 pairs today (51,636,168 tokens), 13 in 7 days (2,249,442,081), 120 in
   30 days (5,302,870,324). Example: transcript `8159416a` replays 23 requests /
   816,135 tokens while persisted `d8111ad4` records 34 requests / 1,117,620 for
   the same run, 83 ms apart; both were counted. This now affects only the
   session-granular tiles and days the ledger does not cover.

5. **Last-wins dedup drops disjoint segments (open).** `dedupBySessionId` keeps one
   record per sessionId, but a resumed conversation legitimately persists several
   non-overlapping segments under one id. 11 ids hold multiple records, 9 of them
   disjoint; dedup discards 22 records / 120,082,542 tokens. `df2ad8ce` holds 6
   segments (07-30 -> 10-15) of which only the last (43,386,166) survives, and its
   transcript is then skipped from replay because its id is in the persisted set.
   Measured impact is confined to windows older than 30 days (0 tokens dropped
   inside today / 7 days / 30 days), so it distorts the heatmap and long ranges.

## Current state

`GET /usage/dashboard` (`packages/cli/src/serve/routes/usage-stats.ts`) caches the
loaded sources for 60 s and re-runs `buildUsageDashboard` per range. Before this
change those sources were only the session history: the durable
`usage_record.jsonl` unioned with a bounded transcript replay, deduped by sessionId
(last wins, persisted wins). The per-request ledger introduced for #4479
(`packages/core/src/services/tokenUsageService.ts`) already stored `localDate`,
`localMonth` and `authType` per API response, and was not read by the dashboard.

The replay cache and scan bounds are owned by
[Usage Dashboard Replay Cache](2026-11-14-usage-dashboard-replay-cache.md), which
explicitly left the local-`today` window semantics out of scope.

## Goals

- Hero, breakdown, daily charts and heatmap reflect tokens actually consumed
  inside the selected window.
- One run contributes once, regardless of resume / clear / branch.
- Keep the dashboard read-only and keep warm loads sub-second.
- Leave the sessions / requests / tool-calls / changes / skills tiles intact.

## Scope boundaries

- In scope: `usage-dashboard-service.ts`, `tokenUsageService.ts` (read path only),
  the `usage-stats` route, and the Web Shell usage tab's output tile.
- Out of scope: the `/stats` session view, whose cumulative resumed-history
  semantics are intentional; the ledger record schema; the persist side of
  `persistSessionUsage`; cost billing; the replay cache's scan bounds.

## Implemented solution (Option A)

**One day/model table, one code path.** `buildUsageDashboard` builds a
`localDate -> model -> counters` table from the session records (the legacy end-day
attribution), then for every day the ledger covers **replaces** that day's entry
with the ledger's. Every token-bearing output — summary token fields, requests,
per-model share, daily tokens, heatmap cells — derives from that table. Sessions,
tool calls, changed lines and skills still come from `aggregateUsage`, because the
ledger deliberately carries none of them.

- `loadTokenUsageDailyByModel(sinceLocalDate)` streams each month file at/after the
  start month, validates every record with the existing `isTokenUsageRecord`, and
  accumulates counters without materializing the history. A missing usage
  directory yields an empty table; any other read error propagates so a partially
  read month cannot silently understate a window.
- `loadUsageDashboardSources()` loads the session history and the ledger together
  over `LEDGER_WINDOW_DAYS = 366`, matching the route's `heatmapDays` clamp so one
  cached load covers every window a caller can request.
- The route's single injectable dependency is now `loadSources`, returning both, so
  a test that injects session records cannot accidentally read the operator's real
  ledger.
- The output tile renders `summary.outputTokens`, which core normalizes per model
  through `outputTokenCount` (defect 1).

**Rejected alternative (Option B).** Add a per-local-day breakdown to
`UsageSummaryRecord` and persist only the current run's delta, subtracting the
replay baseline `beginTelemetrySwap` already snapshots. It keeps a single source
and would also fix the records themselves, but needs per-day buckets in
`UiTelemetryService`, a record schema addition, and a degradation rule for existing
records. It remains the natural follow-up for the persist side of defect 2.

## Design decisions and rationale

- **The ledger is the intended daily source.** #4479 chose per-response JSONL with
  local date and auth type precisely to answer daily / monthly consumption; the
  dashboard predates that alignment and read session summaries instead.
- **Replace per day, never sum.** The same requests exist in both sources, so a
  covered day's session-record copy is dropped rather than added. Summing them
  would reproduce the original inflation.
- **Uncovered days keep the session-record attribution.** This preserves heatmap
  history from before the ledger existed, and the behavior of a user who has usage
  statistics disabled (empty ledger -> unchanged legacy numbers).
- **Calendar-day windows.** Day buckets cannot be split by hour, so `today`, `week`
  and `month` select whole local days (`today` is unchanged; `week` and `month`
  include the full boundary day instead of the hours after a rolling `now - N*24h`).
  This makes the summary agree with the day-bucketed charts. On the legacy path the
  effect is measurable and confined to that one boundary day: for `week` on the
  reference history, 2026-11-12 went from 4,110,008,866 to 17,376,555,073 tokens
  because a session that ended in its first hours carries a replay-inflated
  history. With ledger coverage that day is replaced anyway.
- **Attribution cannot be repaired after the fact.** A session-level total carries
  no day information, so no filter change alone could fix defect 3.
- **Session records stay.** The ledger deliberately stores no project path, tool
  counts, line counts or skill invocations (#4479 privacy boundary), so it cannot
  replace the non-token tiles.
- **No payload shape change.** The dashboard JSON is unchanged, so the SDK types
  and the Web Shell client needed no new fields.

## Constraints

- The dashboard path must not write to `~/.qwen`.
- Ledger writes are gated by `config.getUsageStatisticsEnabled()` and skip internal
  prompt ids (`loggers.ts`), so ledger coverage is not guaranteed.
- Do not add project paths or content to ledger records.
- Do not rewrite or migrate the existing `usage_record.jsonl` in place.
- Preserve the replay cache's warm-load latency and dedup ordering guarantees.

## Risks

- **Partial coverage.** A day where only some processes wrote ledger records is
  replaced wholesale, so the non-writing processes' tokens are lost for that day.
  Same class of gap for history older than the ledger feature.
- **Ledger read cost.** Measured 862 ms to stream and parse 771,906 records
  (~304 MB, 5 month files); the combined source load measured 29.4 s, still
  dominated by the transcript replay, and the route caches it for 60 s.
- **Directory scope.** The ledger lives under `Storage.getRuntimeBaseDir()`, the
  same base its writer uses, while the session history is read from
  `Storage.getGlobalQwenDir()`. They coincide by default; a deployment that pins a
  per-workspace runtime directory would aggregate that runtime's ledger next to
  global session history.
- Defects 4 and 5 still distort the session-granular tiles and uncovered days.
- The persisted records remain inflated, so any other consumer of
  `loadUsageHistory` (notably the TUI cross-session view) still sees the old
  numbers.

## Validation plan

- Unit tests: a ledger-covered day replaces rather than adds; tokens land on the
  day each response happened; uncovered days keep session-record tokens; the loader
  aggregates per day/model, skips earlier days and months, returns an empty table
  with no ledger, and drops invalid/future-schema records; the output tile under
  both provider conventions.
- Route integration through the real loader with both sources seeded on disk.
- Real-data A/B against an independent ledger scan on a **frozen copy** of the
  ledger, so the two arms read identical bytes.
- Mutation-witness each new guard, and record which suites were actually run.

## Acceptance criteria

- With ledger coverage, today / 7 days / 30 days token totals, requests, input,
  cached and thoughts equal an independent ledger aggregate for the same window,
  and every covered day's heatmap tokens and cache rate match. **Verified**: on a
  frozen copy of the reference history all three ranges matched exactly
  (`ALL_RANGES_EXACT=true`, 0 day mismatches).
- `inputTokens + outputTokens == totalTokens` for every range. **Verified.**
- Session-granular tiles (sessions, tool calls, changed lines, skills) are unchanged
  by the ledger. **Verified** against the same records with an empty ledger.
- A session spanning three days contributes to all three day buckets. **Verified**
  by unit test and by the per-day heatmap comparison.
- Warm loads stay sub-second and the dashboard path writes nothing.
- Measured effect on the reference history versus the previous builder: today
  -59.4%, 7 days -75.8%, 30 days -85.9% (live history, so approximate).

## Open questions

- Should the persist side stop writing replayed history (Option B), so the records
  themselves become trustworthy for other consumers?
- Should a day with partial ledger coverage fall back per model instead of being
  replaced wholesale?
- Should daemon sessions persist usage at session end (the open question inherited
  from the replay-cache design), which would shrink the replay path?
- Should the TUI cross-session view (`statsDataService.ts`) adopt the same
  accounting, since it shares `loadUsageHistory` and the same dedup?
- Defects 4 and 5 need a session-identity decision: key the persisted record on the
  transcript's identity (or record both), and dedup on `sessionId` plus the segment
  window so disjoint segments are summed. The pre-deletion salvage and the
  persisting migration share that key, so all three callers must move together.
