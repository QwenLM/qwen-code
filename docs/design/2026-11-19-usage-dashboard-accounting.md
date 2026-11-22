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
   with it: such a run now fails `hasRunActivity` and writes nothing. The 188-of-189
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
  (`UiTelemetryService`, the two replay sites, the run-persist call sites),
  `usageHistoryService`'s record marker and reduction, and the TUI cross-session
  view (`statsDataService.loadStatsData`).
- Out of scope: the `/stats` session view, whose cumulative resumed-history
  semantics are intentional; the ledger record schema and a usage-record version
  bump or migration; migrating records already on disk; cost billing; the replay
  cache's scan bounds. Two optional, additive provenance flags (`runScoped` and
  `transcriptRebuild`) are in scope and are not a schema version change.

## Implemented solution (Option A)

**One day/model table, one code path.** `buildUsageDashboard` builds a
`localDate -> model -> counters` table from the session records (the legacy end-day
attribution), then **replaces** only model/session entries actually covered by
the ledger and adds the ledger's counters. Every token-bearing output — summary token fields, requests,
per-model share, daily tokens, heatmap cells — derives from that table. Sessions,
ended-run duration, tool calls, changed lines and skills still come from
`aggregateUsage`, because the ledger deliberately carries none of them. Both
surfaces filter those records by the same inclusive local-day keys as the token
slice, not by the rolling millisecond cut-off. Per-day `sessions` specifically
means **runs ended on that date**; a cross-midnight run's requests and its end
record can therefore appear on different days.

- `loadTokenUsageDailyByModel(sinceLocalDate)` streams each month file at/after the
  start month, validates every record with the existing `isTokenUsageRecord`, and
  accumulates counters without materializing the history. A missing usage
  directory yields an empty table; any other read error propagates so a partially
  read month cannot silently understate a window. Both surfaces then call the
  loader through `loadLedgerOrEmpty`: any such error degrades to an empty table and
  restores record-derived attribution, including its potentially inflated legacy
  values, with only a debug-log warning rather than failing the whole surface.
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
aggregate and the session bucket. `getLiveMetrics()` supplies the records written
by `/clear`, successful session switches and the process-exit cleanup.

- No subtraction and no schema version bump or migration: the live counter is
  built by the same accumulator, so with no replay it is field-for-field identical
  to the display aggregate. The optional `runScoped` flag and transcript-rebuild
  provenance described in the next section remain compatible with readers that
  do not know these fields.
- The session clock and run clock have distinct owners. `resetLiveMetrics()`
  resets only the live counters and `getRunStartTime()`, not the displayed
  conversation clock. On successful initialization of a different session id,
  the client binds `getSessionStartTime()` to the incoming conversation's own
  `conversation.startTime`, falling back to a fresh Date when that metadata is
  absent or invalid. A selective restore retains `SessionRestoreProjection.startTime`
  in its runtime after the outer projection is consumed, without depending on the
  full resumed-session data or rewinding the active run clock. It does not carry
  the previous conversation's clock into
  the new one. If initialization or replay fails, the replay snapshot restores
  both the prior session and run clocks. `SessionStatsProvider` reads that clock
  after initialization rather than constructing an unrelated `new Date()` for
  each display transition. The swap-persist helper and `/clear` stamp outgoing
  usage with `getRunStartTime()`, and `/clear` fully resets both clocks for the
  new conversation.
- `reset()` clears it, so each `/clear` segment bills only itself. A successful
  `/resume` or `/branch` also writes the outgoing run under its captured session
  id, then calls `resetLiveMetrics()` at the UI commit point. That resets the
  persistable counters and run start time without erasing the incoming
  transcript's display replay, preventing the outgoing run from being written
  under the resumed id at process exit.
- `UiTelemetryReplaySnapshot` carries it, so an aborted swap restores it too and
  cannot leave the live counter inflated by an abandoned replay. The flush only
  occurs on success, never on those rollback paths.
- A resume with neither an API response nor a skill invocation fails the callers'
  `hasRunActivity` check and writes no record, instead of an all-history one. A
  skills-only branch also persists the skills it actually ran, even with no model
  requests.

**Not done: a per-local-day breakdown in `UsageSummaryRecord`.** It was the other
half of the original Option B sketch. With the ledger supplying day attribution it
would only help days the ledger does not cover, at the cost of per-day buckets in
telemetry, a record schema addition and a degradation rule for existing records.
Deferred rather than built speculatively.

## Implemented solution (run-scoped reduction)

`persistSessionUsage` marks what it writes `runScoped: true`, because its caller
passes that run's live metrics. Records reconstructed from a whole transcript
carry no run marker and remain cumulative. Actual event-time reconstruction
(`summarizeTranscriptFile`, the persisting migration and the pre-deletion
salvage) additionally writes `transcriptRebuild: true`, distinguishing measured
history from an old unmarked record whose provenance is unknowable.

`dedupBySessionId` groups by sessionId and then:

- **No run-scoped record in the group** -> ordinary cumulative copies retain
  last-wins. A newer measured transcript reconstruction may replace an older
  reconstruction snapshot by actual event time, so a persisted older snapshot
  cannot hide later native daemon activity.
- **Run-scoped records present** -> retain disjoint runs. Windows are half-open:
  a new run starting exactly when the previous one ended is retained. Equal
  `[startTime, endTime)` windows and partial overlaps are duplicates or
  ambiguous and collapse to the last matching write. Adjacent runs in the same
  millisecond therefore survive.
- **Provenance and window shape.** An ordinary unmarked cumulative record loses
  to run deltas because it may be another replay-inflated copy. A measured
  transcript reconstruction survives beside disjoint runs. New summaries carry
  the API calls' local `execution_id` set, from both successful responses and
  errors. When both sides have identities, a reconstruction replaces a run only
  if its set contains all the run's ids, and if tool/file evidence covers it.
  Disjoint, non-empty id sets are independent activity, not duplicate copies; a
  partial intersection is ambiguous and retains the known run without adding
  a possibly duplicated reconstruction. The same identity check prevents two
  independent same-window runs from being collapsed. Replayed metrics never
  enter this live set. The set lives beside the metrics object rather than in
  its enumerable public shape, so headless JSON remains unchanged.
  Older summaries without identities retain the bounded legacy coverage rules:
  the start and model/tool/file evidence must cover the run, including tool
  names and success/failure outcomes, but exact counter totals still cannot
  establish universal cross-store event identity. Partial overlap retains the
  known run rather than guessing what to subtract. Transcript replay has no
  skill-invocation channel, so known live skills from covered runs are retained
  in the rebuilt summary. The newest reconstruction is selected by actual event
  time, including when runs are present.
- **Different clocks.** A run's timestamp is the wall clock of exit, `/clear`
  or a session swap, whereas a transcript reconstruction ends at its last
  recorded event. A reading pause between them is normal, even when it lasts
  minutes. Coverage never treats a direct comparison of those two clocks as
  proof of a different spending event; identities or bounded legacy evidence
  decide coverage instead. Incomplete or ambiguous reconstruction evidence
  takes the conservative known-run basis.

**Independent late evidence.** A complete reconstruction can be ambiguous
because a public transcript shares only some ids with a run that also contains
internal helper calls. The ambiguous main reconstruction is then not added
again, but a new API response or error with an `execution_id` absent from the
known run and a usable timestamp strictly after that run's persist clock is
kept as an ephemeral `transcriptSupplement`. A supplement is not a new run
and is never persisted as an authoritative full history. Tool/file counters do
not have an execution-id join key. Late tool/file records therefore cannot be
used as evidence for the known run's whole reconstruction; its own known counts
are retained instead of being replaced by a later edit's duration or line delta.
Supplements are collected per execution id, so a live call sharing a tail with
an independent daemon call cannot cause that other call to be discarded. They
contribute only model/API counters and latency, not sessions, run duration,
tools/files or ended-run counts. Each supplement is discarded if another
retained record already contains that api identity, including a full
reconstruction that survived normal identity and non-model coverage.
Old runs without identities keep their earliest-run prefix for disjoint history
while still allowing such explicitly identified late calls; missing identities
or unusable times outside this rule remain a disclosed, bounded join ambiguity,
not proof of a new request. An unparseable conversation-level start or end clock
invalidates the cumulative transcript reconstruction, not already identified
post-boundary supplements; those supplements must survive the null-record
return instead of being lost with the invalid conversation clock.

The minimum cache signature is the file's `(mtimeMs, size)`, exact `beforeMs`
and `afterMs`, and the sorted known execution-id set. A new persisted run can
therefore change reconciliation ownership without incorrectly retaining a
cached supplement from the previous ownership. Boundary supplements never
become durable copies merely because they were cached in memory.

The provenance flags, optional `requestExecutionIds` array and optional failed-
attempt count/latency metadata are additive. Every reader that filters
`version === 1` keeps working without a schema migration or a history rewrite.

**Deliberate trade:** an ordinary cumulative record spanning an upgrade loses to
run deltas even if it covers earlier activity. Measured transcript rebuilds need
not be lost when the later runs are disjoint. Undercounting an ambiguous overlap
is the safe direction; double counting is not.

An empty `usage_record.jsonl` keeps the original full migration even when the
caller names the current session. That session is excluded from **durable
migration**, not from discovering older transcripts. Once history exists,
`loadUsageHistory()` limits supplemental reconstruction to needed run-scoped
ids and the explicit current id, and returns the reduction directly when no
supplement is needed. It does not turn that targeted lookup into an unrelated
session census. Only events with usable timestamps strictly before the relevant
earliest run start are backfilled; later activity remains with its run.
Boundary-limited supplements are ephemeral, never additional authoritative
whole-session snapshots.

A targeted `loadUsageHistory` retains its fast path for an already completed
`transcriptRebuild`, rather than reopening it merely because a later run is
appended. Live discovery instead revalidates eligible recent transcripts and
invalidates the old reconstruction when its `(mtimeMs, size)` signature changes.
It always retains whole-file evidence for identity-bearing runs; an older run
without identities uses its earliest-run boundary to recover only disjoint
history without inventing a join that its aggregate counters cannot support. A cached
whole-transcript summary may satisfy a later boundary only when its own last
timestamp is strictly **before** that boundary: the response at the boundary is
excluded, exactly as a real scan excludes it. Ordinary unknown cumulative copies
still lose to run deltas. Exact-run boundary caches use the file signature
**and** temporal boundary, rather than disabling caching across every transcript.
Cache summaries
never become warm candidates ahead of directory enumeration: duplicate session
ids retain first-occurrence-by-directory-order independently of cache warmth.
A scoped lookup may read exact known files without directory enumeration only
when its ids resolve to one verified project root with matching persisted
project identities and the active mapped transcript exists. When the caller
supplies that workspace, an absent transcript for another known run is skipped
in place rather than triggering a full directory scan. Unknown, multi-root or
caller-mismatched identities retain full directory discovery rather than
guessing;
discovering new, unrecorded daemon sessions always requires bounded discovery.
That single-project fast path belongs only to `loadUsageHistory` with an
explicit id allowlist. `loadUsageHistoryWithLive` does not pass
`projectChatsDirs`: its unscoped discovery must still examine all project
`chats` directories in directory order so never-persisted work in another
project is not lost. A boundary-limited read therefore cannot
borrow a cached whole-transcript summary or make ordinary unrelated sessions
uncacheable.

Otherwise harmless empty calendar days do not require records, but unrelated
unrecorded transcripts still respect `LIVE_REBUILD_WINDOW_DAYS` whenever any
persisted history exists, including a run-only history. Only an empty history
uses the unbounded initial replay, while `sinceMs: 0` is the explicit escape
hatch. `loadUsageHistoryWithLive` merges this recent daemon activity read-only,
whereas a named older run may still receive a precise boundary supplement
beyond that window without opening unrelated stale transcripts.

Forked ancestry is not new branch consumption. `forkSession` stamps
`forkedFrom` on every copied parent record; only those inherited rows are
skipped, not the rest of the transcript. The parent's sessions, requests,
tools, files, skills, duration and project attribution therefore do not appear
again under the branch. Subsequent unmarked API responses, tools and files
remain visible as native branch usage even without a child run record; its
start/end time derives from retained native rows rather than the copied parent
header. A root-key, nesting- and escape-aware scan identifies the marker without
JSON-parsing a large tool payload that merely contains the same text. Inherited
and native objects glued together by an interrupted append are handled
separately: bounded tolerant parsing for small lines, top-level slicing without
full parsing for large ones. The inherited object cannot discard its adjacent
native object. A fork with no native usage still produces no summary, while an
explicit later branch
run remains a separate `runScoped` record. The session-specific display can show
restored parent history by design.

Pre-deletion salvage checks coverage again in both `prepare` and `commit`, so
the second check still handles a racing writer. An ordinary cumulative record
retains its legacy authority. A prior reconstruction or run suppresses salvage
only when its own window encloses the freshly rebuilt window; the marker alone
cannot hide a later native API response. A disjoint run does not: the
reconstructed transcript is persisted too, then reduced with the run by identity
or bounded legacy evidence.

**Session counts now count runs, not conversations.** Keeping every disjoint run
means the sessions tile, the TUI Sessions number and the per-day session counts
read two runs of one conversation as 2 sessions, where last-wins previously read

1. That is the more honest number once each record is a delta rather than a
   cumulative copy, but it is a semantic shift, not an invariant the tiles preserve.

## Implemented solution (TUI cross-session view)

`/stats`'s historical ranges read `loadUsageHistory` + `aggregateUsage` with no
ledger involvement, so they carried the same inflation: measured 2.06x the ledger
truth over 7 days and 6.25x over 30 days, with average latency inflated too
(24,057 ms against 8,621 ms for one day) because the request denominator was
inflated.

The table build and window sum are now **shared exports** of
`usage-dashboard-service` — `buildUsageDayTable(records, ledgerDaily)` and
`sumUsageWindowByModel(table, startKey, endKey)` — used by both surfaces, so the
two cannot drift. `recordTouchesLedgerDays` supplies the exact span-coverage
rule to both the table and the delta; it does not invent an independent coverage
interpretation. `TokenUsageDayModelTotals` gained `apiDurationMs` so successful-
response latency comes from the per-request ledger. Failed attempts stay in
optional per-model run metadata (`errors`, `errorLatencyMs`), and the shared
table supplements their count/duration only for a model covered by the
successful ledger. An uncovered sibling model must not discard those errors.
It does not create an artificial zero-token ledger day that could otherwise
authorize discarding older successful sessions. Failure day attribution
remains session-record based; both surfaces use the same arithmetic. Each
ledger day/model total is cloned before that supplementation, so rebuilding a
dashboard repeatedly from cached sources cannot re-accumulate failure requests
or durations.

`loadStatsData` reads the ledger on every open from the earlier of the earliest
record's start day and the previous comparison window's first day. That makes
replacement independent of the selected display range: an overnight run whose
requests were yesterday cannot be reassigned to today merely because today has
no ledger row yet. Only the window sum, not coverage discovery, is range-bound.
It replaces the current report's `models`, `totalRequests` and
`totalLatencyMs` with the shared token table. A completed-day side uses the
ledger when every active model in its records has ledger coverage, including an
ordinary weekend with no requests and no ledger keys. A genuinely uncovered
active model keeps **both** sides on the session-record basis, rather than
comparing incompatible measurements. Consecutive idle days never
force fabrication of zero-token ledger rows. Concurrent opens of the same start
day share one pending read. Completed-month aggregates are reused only while
their file signatures remain unchanged; a late append forces a fresh read.
The signature is sampled **before** streaming, so an append during the read
cannot pair old content with the newly appended file's signature. The next load
must observe and re-read that change. Current and future month files are always
streamed again. One sorted
ledger-day array is shared by the day table and both comparison sides, rather
than sorting once per record. The day/model table and subsequent report shapes
are rebuilt on each load from those month aggregates. Token streaks count only
days with positive token
spend. Skill calls, files and other non-token fields still come from the session
records, never from an invented model-token surrogate.

The current in-progress record comes from `getLiveMetrics()` and
`getRunStartTime()`, not the display aggregate. Its activity predicate and
record construction are shared with the persistence writer. The session id is
also passed separately, so a restored session with no new live activity can
reconstruct its unpersisted transcript without fabricating an empty run record
or charging replayed history as a new run. Otherwise, the current live record is
built by that shared constructor. The already-reduced history supplies only the
current session's contiguous group for another local reduction; unrelated groups
do not undergo a second whole-history comparison. Earlier disjoint runs and
compatible transcript reconstructions keep their own tokens and session-granular
fields.

Stays on session records: `sessionCount`, `totalDurationMs`, tools, files, skills
and **projects**, all selected by the same inclusive local-day keys as tokens.
The ledger has no project dimension (#4479 privacy boundary), so
the per-project token column cannot be corrected from it and remains
record-derived — an acknowledged inconsistency with the corrected totals rather
than a fabricated attribution.

## Design decisions and rationale

- **The ledger is the intended daily source.** #4479 chose per-response JSONL with
  local date and auth type precisely to answer daily / monthly consumption; the
  dashboard predates that alignment and read session summaries instead.
- **Replace covered model/session entries, never sum a covered request twice.**
  The same requests exist in both sources. A model from a record is omitted if
  that record's `[startTime, timestamp]` span and session/model identity match
  ledger coverage. Other models and independent session records remain additive.
- **Runs with no ledger overlap keep session-record attribution.** This preserves
  heatmap history from before the ledger existed and users who have usage
  statistics disabled. The conservative trade is explicit: if a covered model
  spans both a covered and an uncovered day, its entire record entry is omitted,
  so the model's unattributable part on the uncovered day is lost. For example,
  a 1,100-token record spanning a covered day with 500 ledger tokens and an
  uncovered day reports 500 total, not 1,100; the aggregate record cannot safely
  split the remaining 600 by response date. Unmatched models and sessions are
  still retained. Undercounting that ambiguous portion is preferred to double
  counting.
- **Calendar-day windows.** Day buckets cannot be split by hour, so `today`, `week`
  and `month` select whole local days (`today` is unchanged; `week` and `month`
  include the full boundary day instead of the hours after a rolling `now - N*24h`).
  This makes the summary agree with the day-bucketed charts. Their start dates
  follow the current local calendar date minus 7/30 days at local midnight,
  rather than the local date produced by subtracting a constant number of
  milliseconds across DST transitions. Whole boundary-day inclusion is
  intentional. On the legacy path the effect is measurable and confined to that
  one boundary day: for `week` on the
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
- **Compare completed local days only.** Token and session-record day buckets
  contain no intraday breakdown, so a partial today cannot be compared fairly
  with a full previous day. The delta therefore compares the completed prefix
  of the current range with the same number of disjoint complete days before
  that prefix, counted by calendar day at local noon rather than `N * 24h`.
  Displayed totals still include the partial day; the percentage specifically
  belongs to the completed-day comparison. Today has no completed day and
  returns no delta rather than pretending the unfinished day is zero. Constant
  100-token days yield 0% for week and month including 00:30 and DST transitions;
  there is no invented intraday profile or multiplier derived from a dead field.

## Constraints

- The dashboard path must not write to `~/.qwen`.
- **Ledger scope is user-facing turns, not every model helper call.**
  `logApiResponse` always feeds the live display, but intentionally excludes
  `prompt_suggestion`, `forked_query`, `speculation` and `side-query:*` from the
  persistent ledger and transcript telemetry, along with the other helper-call
  paths gated before those stores. Those calls therefore remain in session/live
  metrics but not in this daily/monthly accounting source; the figures are not
  claimed to be an exhaustive bill including internal compaction, memory or
  routing helpers. The boundary and any loss are deliberate and disclosed rather
  than silently repaired everywhere.
- **Missing provider totals follow auth semantics.** When a provider omits
  `total_token_count`, `apiResponseEventToTokenUsageRecord` asks the shared
  `outputIncludesThoughts` helper instead of unconditionally adding reasoning.
  OpenAI chat completions, OpenAI Responses, Qwen OAuth and Qwen subscription
  auth already include reasoning in output; Gemini-style providers keep it
  separate. The generic fallback for unrecognized conventions remains unchanged.
- **Legacy totals are normalized per persisted record.** A pre-upgrade writer
  could include reasoning in `totalTokens` even when `outputTokens` already did.
  The ledger reader uses `authType` while accumulating each row, then carries
  `inputTokens` plus reasoning-once output into the day/model and query totals.
  The API and exported summaries preserve the provider-reported `outputTokens`,
  while `totalTokens` contains billing output with reasoning counted once. This
  changes only the read-side view; it neither rewrites nor migrates old rows.
  A provider's positive total is retained when its normalized input/output
  components are zero, so total-only responses are not suppressed.
- **Legacy managed usage keeps its closed api shape.** Failure-latency tracking
  remains available to the usage statistics, but the non-diagnostics managed
  serializer strips that new counter from model and source `api` objects rather
  than extending the consumers' exact three-key contract.
- **Coverage is scoped to model and shared session identity.** The ledger
  reader keeps persisted `sessionId` values in a private WeakMap across
  completed-month caching and known-root merging. The day table skips only the
  covered model/run entries, then sums genuine unmatched history rather than
  replacing an entire day. A day and model alone are not proof that another
  session's activity can replace a record. Inputs without that metadata retain
  the bounded legacy behaviour, not a claim of a universal event join. Ledger
  `id` and telemetry `execution_id` remain separate identities.
- Ledger writes are gated by `config.getUsageStatisticsEnabled()` and skip internal
  prompt ids (`loggers.ts`), so ledger coverage is not guaranteed.
- Do not add project paths or content to ledger records.
- Do not rewrite or migrate the existing `usage_record.jsonl` in place.
- Preserve the replay cache's warm-load latency and dedup ordering guarantees.

## Risks

- **Partial record-span coverage.** A model/session covered on only some of
  its run's local days still cannot distribute that full model's spending
  precisely across those days without inventing timestamps. The covered
  requests are not added twice; uncovered portions have no exact per-day
  attribution. Unmatched models and sessions now keep their conservative
  record-day attribution instead of being overwritten by an unrelated ledger.
- **Ledger read cost.** Measured 862 ms to stream and parse 771,906 records
  (~304 MB, 5 month files); the combined source load measured 29.4 s, still
  dominated by the transcript replay, and the route caches it for 60 s.
- **Directory scope.** The route reads the ledger roots of registered workspaces,
  plus the global `~/.qwen` root used by default CLI sessions. `path.resolve()`
  normalizes spellings before de-duplication, including trailing separators;
  it does not collapse distinct symlink aliases. Shared roots are loaded once;
  distinct known roots are merged. It does not fall back from a known
  workspace root to an unrelated ambient process runtime. Global session history
  is loaded independently and is never narrowed to those workspaces. For a
  historical runtime that is no longer discoverable, records retain their
  conservative session-record attribution rather than being rewritten from a
  wrong-scope ledger; this does not invent per-request attribution for the
  undiscoverable root.
- **Existing history is mostly replay.** 1,482 of 2,065 persisted records (72%)
  belong to ids with zero ledger requests, totalling 376,868,201,294 tokens. The
  ledger only starts 2026-07-30 and a run with usage statistics disabled also
  writes none, so this is an upper bound on the replay footprint, not a proof that
  every one of those records is inflated.
- **Mixed-era sessions.** A conversation spanning the upgrade drops an unmarked
  cumulative copy when run deltas exist, so ambiguous pre-upgrade activity can
  be undercounted. A real transcript rebuild remains alongside disjoint later
  runs (see the deliberate trade above).
- **Per-project tokens stay inflated.** The TUI projects table cannot be corrected
  from the ledger, so it disagrees with the corrected totals above it.
- **Calendar-day windows now apply to every record-derived tile too.** Tokens,
  sessions, duration, tools, files and skills all include the whole boundary day;
  the TUI's previous comparison window is disjoint and has the same number of
  completed days. The daemon's per-day `sessions` field remains an ended-run
  series, not an assertion that all shown tokens belong to runs ending that
  same day. The displayed Today counts still include an unfinished day, while a
  comparison has no scope unless at least one prior local day is complete.
- Records written before this change stay inflated, so other consumers of
  `loadUsageHistory` that this PR does not convert (for example the per-project
  token column and the pre-repair fallback window) still show the old numbers for
  that history. Only newly written records are correct.
- **Caching is limited to completed months.** The TUI validates completed-month
  aggregates against the latest `(mtimeMs, size)` before reuse, so a late append or
  replacement invalidates the cached month instead of remaining stale. It also
  coalesces concurrent pending reads. The current month is always re-read, so a
  real-append test sees the new tokens on the next open, and
  `_resetStatsLedgerCacheForTest` clears the caller's completed-month cache in
  addition to pending reads. The daemon retains its independent 60-second source
  cache.

## Validation plan

- Unit tests: a ledger-covered day replaces rather than adds; tokens land on the
  day each response happened; a run touching any covered day is dropped while a
  wholly uncovered run keeps its record tokens; the loader aggregates per
  day/model, skips earlier days and months, returns an empty table
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
- Reduction: unit tests for run scoping and transcript provenance, disjoint runs
  surviving, partial-overlap and identical-window writes collapsing, stale
  cumulative records keeping last-wins, ambiguous copies losing to run deltas,
  and actual reconstruction surviving disjoint later runs. Include a mixed
  overlap/disjoint group, full-coverage replacement, zero-length cross-source
  copies, and an old unmarked migration whose later transcript contains new API
  activity. Its pre-run events must survive without double-counting later run
  activity; the temporal supplement must not be persisted as a fresh authority.
  Repeated reads of the same file at two distinct boundaries verify distinct
  bounded summaries. A known older run transcript is admitted outside the
  mtime window while unrelated stale files stay unopened. Duplicate ids choose
  the same directory-first project with a warm or cold cache. A real fork
  followed by unmarked daemon telemetry counts the new activity exactly once,
  derives its duration only from native rows, and a large nested/quoted marker
  never causes the large tool payload to be parsed.
- TUI: unit tests for day replacement, per-day attribution, wholly uncovered runs,
  a ledger-backed previous window, equal-length flat-usage deltas, same-day
  record-derived fields, and fresh reads between opens. Also cover replay-only
  current sessions creating no record, a live run merging with disjoint prior
  runs, and pairwise ledger coverage falling both delta sides back to records
  when either side is incomplete. Also cover zero-record sparse-ledger deltas and
  zero-token skill activity without a token streak. Mount the data-loading
  component with the real context shape and assert it passes live metrics and
  run start. Merge only the current session group and verify the reducer's input
  size does not include unrelated sessions. Bind the incoming conversation's
  clock at successful initialization, preserve the displayed conversation clock
  through live reset, and restore both clocks after rollback. Include real files
  for an existing A session and a never-persisted B session, with and without
  new activity, so history is included once and the current session is not
  prematurely persisted. Multiple covered records share one ledger-key
  enumeration across both comparison windows.
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
- A real transcript migration stays beside a disjoint live run. **Verified** by
  unit tests and on actual JSONL using the isolated runtime: 1,000 + 200 = 1,200,
  and the `loadStatsData` all-time row had the same total and two runs.
- Current stats do not convert replayed history into a live record, preserve the
  session clock across a live reset, and compare matching bases. **Verified** in
  the focused suites and real-file oracle: replay-only returned no record; the
  the restored conversation supplied the display clock while the run start
  advanced independently; a partial ledger
  yielded the same-record-basis -100% delta, while complete coverage on both
  sides yielded +100%. The current token table independently summed to 7,007.
  `SessionStatsProvider` also kept the original fake-time clock after Ink's
  `startNewSession()` call; before that follow-up fix the test really advanced
  its wall clock by the simulated minute.
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

- How should the uncovered part of a model/session with only partial day
  coverage be represented without inventing response timestamps?
- Should existing inflated records be repaired or marked, so the TUI
  cross-session view and the fallback path stop showing them? The 72% figure above
  sizes that work.
- Should daemon sessions persist usage at session end (the open question inherited
  from the replay-cache design), which would shrink the replay path?
- Should the per-project token column be dropped, relabelled, or attributed some
  other way, now that it disagrees with the corrected totals?
- No session-identity change is needed: finding 4 was retracted, and the reduction
  keys on `sessionId` plus the run window without touching what any writer uses as
  its identity. The pre-deletion salvage and persisting migration still write
  cumulative event-time reconstructions. They suppress only an already covered
  transcript, and explicit reconstruction provenance preserves disjoint history
  beside per-run deltas.
