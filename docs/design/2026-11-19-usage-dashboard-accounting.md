# Usage Dashboard Accounting

[English](2026-11-19-usage-dashboard-accounting.md) | [简体中文](2026-11-19-usage-dashboard-accounting.zh-CN.md)

Status: implemented. Defect 1 is fixed outright; defect 2 is fixed on both the
read and persist sides; defect 3 is fixed wherever the per-request ledger covers
the day, on the daemon dashboard **and** the TUI cross-session view. Finding 4 is
**retracted** — the ledger disproved it. Finding 5 is **corrected**: last-wins was
right for existing records, and what needed fixing is the run-delta regression
that fixing defect 2 introduces. Records written before these changes stay as they
are — there is no migration.

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

Three defects produce the gap. Two further findings from the first pass are
recorded below with their corrections, because both were reported as measured
defects and neither survived an independent check.

1. **Reasoning billed twice (fixed).** The output tile rendered
   `summary.outputTokens + summary.thoughtsTokens`, but chat-completions providers
   already include reasoning in the output count. Today's tile read 7,208,898
   against a provider output of 4,952,378 (+45.6%), and input + output did not sum
   to the hero total.

2. **Resumed history persisted as new usage (fixed).**
   `persistSessionUsage` wrote `uiTelemetryService.getMetrics()`, which a
   session-swap replay has already filled with the resumed conversation's whole
   history. Session `4669c795-e9bc-4ae7-9a1e-1c75795cf446` covers a 7-minute window
   (01:04:23 -> 01:11:54) yet carries 45,679,298 tokens across 506 requests, and its
   per-model totals are identical to the full-history telemetry of transcript
   `df2ad8ce-e86d-49f5-80c7-6012e8736660` (6,682,231 / 5,209,415 / 30,559,974 for
   `qwen3.8-max-preview` / `gpt-6-astra` / `glm-5.3`). Every resume of that
   conversation appends another full copy. This is the dominant term. Both sides
   are now fixed: the dashboard does not read those tokens for a day the ledger
   covers, and a run no longer persists history it did not spend.

3. **Windows attributed by session end (fixed where the ledger covers).**
   `aggregateUsage` filters on `r.timestamp` (the session's last record) and the
   daily/heatmap builders bucket on the same value, so a session's entire spend
   lands on the day it last ran. Session `864fc39f-956e-48ce-810d-231d9e2f82aa`
   contributed 335,062,436 to "today" while its events bucket to 126,738,776
   (11-15), 207,250,267 (11-16) and 1,073,393 (11-18). Seven of today's 42 sessions
   started on earlier days and carried 818,260,710 tokens (48.4% of the displayed
   total).

4. **"One run counted twice under two session ids" — retracted.** The first pass
   read the id mismatch between transcripts and persisted records as an identity
   divergence (`chatRecordingService`'s `binding ?? pinnedSessionId ??
config.getSessionId()` versus `config.getSessionId()`), and reported 2 same-run
   pairs today (51,636,168 tokens), 13 in 7 days, 120 in 30 days. The ledger, which
   keys on `config.getSessionId()` at response time, disproves it: all four
   persisted ids in those pairs (`d8111ad4`, `d7a62020`, `15c11db0`, `4669c795`)
   have **zero ledger requests and no transcript file**, while the transcript ids
   they were paired with (`8159416a`, `7f6dc04d`) have 31 and 257 ledger requests,
   own transcripts, and **zero persisted records**. There is no second identity —
   those persisted records came from runs that made no request of their own and
   wrote only replayed history. It was a symptom of defect 2, and it disappears
   with it: such a run now fails `hasActivity` and writes nothing. The 188-of-189
   unmatched transcripts are simply runs that never persisted.

5. **Last-wins dedup — corrected, and the regression it now needs to avoid.**
   The first pass reported that last-wins drops 22 records / 120,082,542 tokens of
   real usage across 11 multi-record ids. Classifying segments as "disjoint" by
   their _windows_ was misleading: their _contents_ are cumulative copies.
   `6eed223d` holds 5 segments of exactly 35,036 tokens each and its ledger truth
   is 35,036. Across the 7 multi-record ids that have ledger presence, last-wins
   keeps 52,500,008 against a ledger truth of 54,780,252 (4% under), while summing
   the segments would give 172,089,989 — **3.1x the truth**. So last-wins was
   accidentally right for pre-existing records, and "fixing" it by summing would
   have been a regression.

   What is real is the consequence of fixing defect 2: once each record is a run
   delta, last-wins silently drops every run but the last. Reproduced with the
   real persist and load functions — two runs of one conversation (1,000 + 2,000
   tokens) loaded back as one record / 2,000 tokens. That is fixed here.

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
- Leave the sessions / tool-calls / changes / skills tiles intact. Requests and
  latency deliberately move to the ledger with the rest of the token counters.

## Scope boundaries

- In scope: `usage-dashboard-service.ts`, `tokenUsageService.ts` (read path only),
  the `usage-stats` route, the Web Shell usage tab's output tile, the persist side
  (`UiTelemetryService`, the two replay sites, the two persist callers),
  `usageHistoryService`'s record marker and reduction, and the TUI cross-session
  view (`statsDataService.loadStatsData`).
- Out of scope: the `/stats` session view, whose cumulative resumed-history
  semantics are intentional; the ledger record schema and a usage-record version
  bump or migration; migrating records already on disk; cost billing; the replay
  cache's scan bounds. One optional, additive record flag (`runScoped`) is in
  scope and is not a schema version change.

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

## Implemented solution (persist side)

**A second counter that only real events feed.** `UiTelemetryService` keeps
`#liveMetrics` alongside the display aggregate. `addEvent` feeds both;
`addReplayedEvent` — used by the two replay sites, `replayUiTelemetryFromConversation`
and `LlmClient.initialize()`'s restore-runtime branch — feeds only the display
aggregate and the session bucket. `getLiveMetrics()` is what the two persist
callers (`/clear` and the process-exit cleanup) now write.

- No subtraction and no schema version bump or migration: the live counter is
  built by the same accumulator, so with no replay it is field-for-field identical
  to the display aggregate. The only record-shape addition is the optional
  `runScoped` flag described in the next section, which every existing reader
  already ignores safely.
- `reset()` clears it, so each `/clear` segment bills only itself.
- `UiTelemetryReplaySnapshot` carries it, so an aborted swap restores it too and
  cannot leave the live counter inflated by an abandoned replay.
- A resume that makes no request of its own now fails the callers' `hasActivity`
  check and writes no record at all, instead of an all-history one.

**Not done: a per-local-day breakdown in `UsageSummaryRecord`.** It was the other
half of the original Option B sketch. With the ledger supplying day attribution it
would only help days the ledger does not cover, at the cost of per-day buckets in
telemetry, a record schema addition and a degradation rule for existing records.
Deferred rather than built speculatively.

## Implemented solution (run-scoped reduction)

`persistSessionUsage` marks what it writes `runScoped: true`, because its caller
passes that run's live metrics. Records reconstructed from a whole transcript
(`summarizeTranscriptFile`, the persisting migration, the pre-deletion salvage)
carry no marker — they are cumulative.

`dedupBySessionId` groups by sessionId and then:

- **No run-scoped record in the group** -> last-wins, exactly as before. This is
  what keeps existing history unchanged and keeps the #4994 duplicate protection.
- **Any run-scoped record** -> keep the run-scoped ones, dropping every cumulative
  record for that id (a whole-transcript replay must not be added on top of
  persisted runs). Among the runs, a record replaces the kept ones whose window it
  overlaps and is otherwise added, so disjoint runs all survive while a run
  written twice still collapses to the last.

The marker is an optional field, so every reader that filters `version === 1`
keeps working and no migration is needed.

**Deliberate trade:** for a conversation that spans the upgrade, a cumulative
record and run deltas coexist under one id. The cumulative one is dropped even
though it may cover earlier runs, because it may also be replay-inflated.
Undercounting that ambiguous overlap is the safe direction; double counting is
not.

## Implemented solution (TUI cross-session view)

`/stats`'s historical ranges read `loadUsageHistory` + `aggregateUsage` with no
ledger involvement, so they carried the same inflation: measured 2.06x the ledger
truth over 7 days and 6.25x over 30 days, with average latency inflated too
(24,057 ms against 8,621 ms for one day) because the request denominator was
inflated.

The table build and window sum are now **shared exports** of
`usage-dashboard-service` — `buildUsageDayTable(records, ledgerDaily)` and
`sumUsageWindowByModel(table, startKey, endKey)` — used by both surfaces, so the
two cannot drift. `TokenUsageDayModelTotals` gained `apiDurationMs` so the latency
column comes from the same source as the tokens.

`loadStatsData` loads the ledger once (reaching back far enough for the previous
range too), builds the table, and replaces the report's `models`, `totalRequests`
and `totalLatencyMs` for both the current and the previous window — otherwise the
delta would compare a ledger-backed present against a record-backed past. Heatmap,
tokens-per-day and streaks derive from the table.

Stays on session records: `sessionCount`, `totalDurationMs`, tools, files, skills
and **projects**. The ledger has no project dimension (#4479 privacy boundary), so
the per-project token column cannot be corrected from it and remains
record-derived — an acknowledged inconsistency with the corrected totals rather
than a fabricated attribution.

## Design decisions and rationale

- **The ledger is the intended daily source.** #4479 chose per-response JSONL with
  local date and auth type precisely to answer daily / monthly consumption; the
  dashboard predates that alignment and read session summaries instead.
- **Replace per day, never sum.** The same requests exist in both sources, so a
  covered day's session-record copy is dropped rather than added. Summing them
  would reproduce the original inflation.
- **Uncovered days keep the session-record attribution.** This preserves heatmap
  history from before the ledger existed, and the behavior of a user who has usage
  statistics disabled (an empty ledger leaves those days record-derived). The only
  exception is the window boundary day, which the next bullet measures moving.
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
- **One table, two surfaces.** Extracting the table build and window sum rather
  than reimplementing them for the TUI keeps a single accounting truth; the
  dashboard's frozen-ledger exactness was re-checked after the extraction.
- **Exclusive window ends.** The previous-range bound is exclusive, so its last
  local day is `localDateKey(end - 1)`. Treating it inclusively pulled today into
  "yesterday" and was caught by the delta test.

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
- **Existing history is mostly replay.** 1,482 of 2,065 persisted records (72%)
  belong to ids with zero ledger requests, totalling 376,868,201,294 tokens. The
  ledger only starts 2026-07-30 and a run with usage statistics disabled also
  writes none, so this is an upper bound on the replay footprint, not a proof that
  every one of those records is inflated.
- **Mixed-era sessions.** A conversation spanning the upgrade keeps only its run
  deltas, so pre-upgrade activity for that id can be undercounted (see the
  deliberate trade above).
- **Per-project tokens stay inflated.** The TUI projects table cannot be corrected
  from the ledger, so it disagrees with the corrected totals above it.
- **Calendar-day windows now apply to the TUI too.** Its heatmap, tokens-per-day
  and delta previously filtered by millisecond bounds; the boundary day is now
  whole, matching the dashboard.
- Records written before this change stay inflated, so other consumers of
  `loadUsageHistory` that this PR does not convert (for example the per-project
  token column and the pre-repair fallback window) still show the old numbers for
  that history. Only newly written records are correct.
- The live counter is process-wide, like the display aggregate it mirrors, so a
  long-lived process that switches sessions without `/clear` still attributes its
  total to the last session id. That is pre-existing behavior, unchanged here.

## Validation plan

- Unit tests: a ledger-covered day replaces rather than adds; tokens land on the
  day each response happened; uncovered days keep session-record tokens; the loader
  aggregates per day/model, skips earlier days and months, returns an empty table
  with no ledger, and drops invalid/future-schema records; the output tile under
  both provider conventions.
- Route integration through the real loader with both sources seeded on disk.
- Real-data A/B against an independent ledger scan on a **frozen copy** of the
  ledger, so the two arms read identical bytes.
- Persist side: unit tests for the live counter (replay excluded, parity with no
  replay, reset, aborted-swap restore), the real `/resume` + `/branch` harness
  asserting display keeps history while live does not, and `/clear` asserting a
  pure resume writes no record. Plus a two-arm probe driving the real replay and
  persist functions from each checkout.
- Reduction: unit tests for the marker on write, disjoint runs surviving, a run
  written twice collapsing, cumulative records keeping last-wins, a cumulative
  record losing to run deltas, and a whole-transcript replay not adding on top.
  Plus a two-arm comparison of `loadUsageHistory` on the real history.
- TUI: unit tests for day replacement, per-day attribution, uncovered days, and a
  ledger-backed previous window for the delta; plus `loadStatsData` against an
  independent ledger scan on both the live history and a frozen copy.
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
- A run that resumes a long conversation persists only its own requests.
  **Verified** by a two-arm probe using the real replay and persist functions: a
  400-response history plus one live request persisted 401 requests / 400,000,005
  input tokens before the change and 1 request / 5 input tokens after, while the
  display aggregate stayed 401 / 400,000,005 in both arms.
- Two runs of one conversation both survive the read side. **Verified**: the same
  probe loaded 1 record / 2,000 tokens before the reduction change and 2 records /
  3,000 after.
- Existing history reduces exactly as before. **Verified** on the real
  `usage_record.jsonl`: 2,065 raw records, none marked, both arms returning 2,043
  records / 379,387,040,763 tokens with an identical per-session/per-window key
  (`IDENTICAL_REDUCTION=true`).
- The TUI cross-session view matches the ledger for tokens, requests, average
  latency and cache hit rate. **Verified** on the live history and on a frozen
  copy: all three windows at 1.00x (before: 2.06x for 7 days, 6.25x for 30 days).
- The dashboard stays exact after the shared-table extraction. **Verified**:
  `ALL_RANGES_EXACT=true`, 0 day mismatches on a fresh frozen copy.

## Open questions

- Should a day with partial ledger coverage fall back per model instead of being
  replaced wholesale?
- Should existing inflated records be repaired or marked, so the TUI
  cross-session view and the fallback path stop showing them? The 72% figure above
  sizes that work.
- Should daemon sessions persist usage at session end (the open question inherited
  from the replay-cache design), which would shrink the replay path?
- Should the per-project token column be dropped, relabelled, or attributed some
  other way, now that it disagrees with the corrected totals?
- No session-identity change is needed: finding 4 was retracted, and the reduction
  keys on `sessionId` plus the run window without touching what any writer uses as
  its identity. The pre-deletion salvage and the persisting migration keep writing
  cumulative records and are unaffected.
