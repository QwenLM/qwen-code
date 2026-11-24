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

- In scope: `usage-dashboard-service.ts`, the optional response-to-`executionId`
  writing, reading and completed-month copy/merge paths in `tokenUsageService.ts`,
  the `usage-stats` route, the Web Shell usage tab's output tile, the persist
  side (`UiTelemetryService`, the two replay sites, the run-persist call sites),
  `usageHistoryService`'s record marker and reduction, and the TUI cross-session
  view (`statsDataService.loadStatsData`).
- Out of scope: the `/stats` session view, whose cumulative resumed-history
  semantics are intentional; a ledger or usage-record schema-version bump or
  migration; rewriting records already on disk; cost billing; the replay cache's
  scan bounds. The optional `executionId` field on newly written response rows
  requires no version change. The two optional, additive provenance flags
  (`runScoped` and `transcriptRebuild`) likewise are not a version change.
  Per-root ledger/history pairing and its replay-cache lifecycle implement the
  root-isolation correction, not a change to the separate replay-scan design.

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
- Tests can inject the whole source set through `loadSources`. The real loader
  additionally accepts `getLedgerRuntimeBaseDirs`, supplying registered
  workspaces' runtime roots. Callers that do not replace the whole loader need
  this second dependency to aggregate those roots.
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

`dedupBySessionId` groups by sessionId and project, then:

- **No run-scoped record in the group** -> ordinary cumulative copies retain
  last-wins. A newer measured transcript reconstruction may replace an older
  reconstruction snapshot by actual event time, so a persisted older snapshot
  cannot hide later native daemon activity. Replay may return a whole
  reconstruction beside its bounded tail at the same event time. The whole
  snapshot wins only when both records have non-empty arrays of unique,
  non-empty string IDs, it contains every tail ID, and its model/tool/file
  counters cover the tail. Malformed, duplicate, new or conflicting identities
  remain conservative instead of being absorbed by time or token totals alone.
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
  in the rebuilt summary. Their by-name counters merge into a null-prototype
  map so names such as `__proto__` remain own enumerable properties. The newest
  reconstruction is selected by actual event time, including when runs are
  present.
- **Different clocks.** A run's timestamp is the wall clock of exit, `/clear`
  or a session swap, whereas a transcript reconstruction ends at its last
  recorded event. A reading pause between them is normal, even when it lasts
  minutes. Coverage never treats a direct comparison of those two clocks as
  proof of a different spending event; identities or bounded legacy evidence
  decide coverage instead. Incomplete or ambiguous reconstruction evidence
  takes the conservative known-run basis.

**Exact per-response ledger identity.** When a real API response supplies an
`execution_id`, its successful-response ledger row retains that identity as an
optional `executionId`, separately from the ledger row's random `id`. The
current-month reader and completed-month copy/merge preserve this evidence.
For a run-scoped record, the eligible day/model/session ledger buckets must
establish every ID in its non-empty `successfulRequestExecutionIds`, including
across multiple local days. Each ID must come from a response row belonging to
the record's own session; session and ID unions from different rows cannot be
combined. For every expected ID, collect its fingerprints across all relevant
day/model buckets before deciding; distinct evidence on another day or for a
different API duration leaves it unproven. Lazy per-table day/model indexes
preserve candidates without rescanning a whole bucket for every run. A
per-`TokenUsageDailyByModel`/day/model WeakMap stores
session→executionId→raw row and session→executionId→fingerprints, and is used
only with complete evidence. An evidence merge invalidates its derived view;
incomplete/budget-released evidence can only return the empty proof, never a
stale index or stronger deduction. It is private read-only metadata and does
not extend ledger/dashboard JSON or write files. Where covered snapshots are
reconciled again, the same snapshot must not be appended on every future-only
read. Late evidence can still be discovered without another migration write,
while a genuinely new project migration can persist once, rather than
repeating identical covered rows. A supplied
execution ID is optional: one response lacking it leaves the successful-ID list
incomplete. A known matching ID then cannot stand in for the remaining
response's lineage. Owner-aware reads retain the run and ledger rather than
using date/model counts as a substitute, accepting the same disclosed possible
duplicate as the other unresolved evidence boundaries. The covered
successful-ID count must also match
each model's successful request count. Consumption counters must also agree,
with provider-aware equivalences rather than unconditional arithmetic. When
prompt tokens are omitted, the ledger uses cached tokens as their lower-bound
input. Apart from the explicit cache-only normalization below, input must
match exactly; an arbitrary difference within the cached amount is not one
API response. Output, cached and reasoning counts, successful request count
and grand total remain strict. Missing totals follow each ledger
row's `outputIncludesThoughts(authType)`, so already-included reasoning is not
added back while a missing-total session fallback is compared coherently.
A 100-token response still cannot stand in for an independently observed
200-token record merely because they share a request ID. Missing, empty,
different or incomplete identity cannot use this path to erase independent
real consumption. Cache-only normalization is still accepted, but only when raw session input
is zero and cached input is positive. The ledger proxy input must equal that
cache exactly, and the ledger total either must already equal the session's
coherent total or must exceed it by exactly the complete cached amount. This
never overrides a conflicting session grand total. Missing totals from mixed
providers sum `inputTokens + outputTokens + (outputIncludesThoughts(authType)
? 0 : thoughtsTokens)` separately for each row's authType; that coherent
number may match only when the session's complete component sum agrees. It
does not demote a 100-token row and a conflicting 200-token record into one
API response merely because execution IDs match.
The bounded transcript/ownership fallback remains for legacy compatibility; a
missing or conflicting owning-root path does not authorize a coincidental join.
An owner-aware reader does not demote new conflicting identity evidence to
session/day/model matching; raw legacy tables without that metadata retain their
compatibility fallback. Incomplete metadata therefore retains the disclosed
possible legacy duplicates rather than guessing identity from counts. An old
record with no project field cannot be assigned to the active project merely
because its session, time window, and tokens agree. Without actual ownership
proof, it remains separately available, potentially duplicating a reconstructed
view; project names and sanitized path spellings never substitute for this
proof. Different explicitly-known projects still remain separate. This
separates successful responses
from failed attempts, which have no successful-response ledger row. A present
but non-string optional
`executionId` makes that ledger row invalid for aggregation.

An owner-scoped ledger may use the same proof for its own measured
`transcriptRebuild`; an explicit runtime-scoped build may also establish that
proof across roots. Neither turns an ordinary cumulative record into a
run-scoped proof. A caller-declared current live record is a separate explicit
owner boundary, not a blanket same-session exemption. Only when that exact
record has a complete, unique, non-empty execution-ID set and no recorded
model errors may those request IDs stand in for a legacy missing
successful-ID list; every ID still has to establish the same response-row
fingerprint and per-model count. It cannot legitimize a failed request, an
unknown relationship, or a same-id record from another project. A live record
without such IDs is retained beside the ledger rather than erased by the
legacy fallback. Likewise, a live request ID that cannot yet be found in the
complete execution-evidence tables cannot be covered by an older ledger. If
only part of a live record is already persisted, subtract only uniquely
fingerprinted same-model response rows whose consumption is compatible with
the live counters; preserve the unpersisted residue instead of leaving the
whole record to be counted again beside the ledger. Recombined active copies
match the caller by session/project and the complete ID set, never array
order, but any conflicting fingerprints for an expected response prohibit
partial deduction. Global
same-session project ambiguity does not invalidate another root's complete,
individually compatible owner-local exact proof; each such proof is evaluated
against that root's own transcript/project scope, never a merged token count.

The in-memory evidence table supplies day/model,
session and execution-ID metadata, but zero token counters. Its dates are united
with the local root's dates for exact-ID proof alone. The lookup also includes
the actual queried root's dates, so an empty global ledger cannot hide another
complete root's day buckets. Normal cross-day responses can use complete local
proof; what is rejected is conflicting fingerprints for the same execution ID,
not the number of dates. The existing legacy fallback still examines only the
local root's days and owning transcript scope.

Duplicate scoped ledger rows require an exact response fingerprint:
original localDate, session, model, execution ID, auth type, source, response
timestamp and all response counters, including API duration. A random ledger-row ID is deliberately
excluded. Only later identical rows are subtracted from the in-memory aggregate;
the on-disk ledger is unchanged and different evidence remains. Copying such a
row uses the same provider normalization as addition, including totals-only
records. The ledger's own session/execution indexes and owning scope follow that
ledger map through these copies; borrowing scope from the records array would
lose the ownership proof. The duplicate execution-ID set is constructed on
demand, avoiding a second always-resident index of every response.

**Bounded identity evidence.** Monthly JSONL is still streamed, but at most
`MAX_LEDGER_EXECUTION_EVIDENCE_RECORDS` (10,000) complete response rows are
held for identity proof per logical ledger table, including its
completed-month and merged derivatives. If a stream or merge exceeds that
budget, the private execution evidence is released and marked incomplete.
The separate permanent execution-ID set is not retained either. Full
session/model/day counters continue accumulating from every valid in-scope row.

Rows without an execution ID retain only private day/model/session presence
as ambiguous evidence and count toward that same budget, not an extra one.
Merging preserves this metadata. Releasing raw rows or fingerprint evidence at
the budget limit does not erase this ambiguity veto, which is not itself exact
proof. Such a row cannot be treated as an absent ledger or be used by the
legacy fallback to erase a response with known IDs.

A completed-month aggregate also has a separately bounded snapshot of its
latest day's complete identity evidence. It is reused only by a partial-month
query starting exactly on that day and only while the file signature is
unchanged. Other partial windows stream the file for scoped evidence. When that
fallback scan occurs, its counters and identity evidence come from that same
scan, never mixed with the cached snapshot. A whole month's earlier rows cannot
consume the narrow window's budget or silently replace its exact identity.

Once that bound is exceeded, identity proof cannot be allowed to pretend that
a bounded sample is exhaustive. `isCompleteLedgerExecutionEvidence` becomes
false; new exact-ID matching and scoped-ledger subtraction using that evidence
are unavailable. Complete per-root maps are queried independently from this
bounded union, however, so discarding an over-budget merge does not discard
otherwise complete local response proofs. A run-scoped legacy day/session
fallback still needs its unique expected
transcript path; scoped ownership ambiguity retains possible duplicates.
Compatibility without per-response execution evidence does not turn a missing
legacy path, an unknown project, or a finite execution-evidence budget into a
new exact-ID proof. Unscoped legacy cumulative records retain their existing
limited day/session compatibility, but modern conflicting identity evidence
still vetoes a session/model shortcut. When complete evidence is available, a conflicting or incomplete
explicit identity remains a veto, not a license for a session/model shortcut.
Changing the in-memory cache
never edits a transcript, a durable usage record or a ledger row, and this is
not a claim that a bounded-budget ledger can reproduce all exact deduplication.

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

The provenance flags, optional `requestExecutionIds` and
`successfulRequestExecutionIds` arrays and optional failed-attempt
count/latency metadata are additive. Every reader that filters `version === 1`
keeps working without a schema migration or a history rewrite.

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

When the caller supplies the current project root, durable migration excludes
only that exact project/session pair, not a same-id transcript from another
project. The active project's snapshot is deferred to its own exit persistence,
but the other project's reconstruction is still durable after a repeat load and
(if necessary) transcript deletion. A record reconstructed under that other
project cannot narrow the active session's directory candidates or authorize
the early return before the active project itself has inspected coverage.
Without the project-root option, the legacy whole-session exclusion remains.

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
when every id resolves to exactly one verified transcript path, either from
matching persisted project metadata or the caller's explicitly supplied active
workspace. These verified paths may span different project directories. When
the caller supplies that workspace, an absent transcript for another known run
is skipped in place rather than triggering a full directory scan. A session id
with multiple candidate roots, no resolved transcript mapping, or a stale file
retains full directory discovery rather than guessing. A mismatch between the
caller workspace and persisted project metadata does not itself force root
enumeration; it requires the mapped transcript to exist. Empty boundary maps
also do not prove that a current transcript has no real activity: a
non-persisted session beside legacy cumulative history
still needs reconstruction. Eliminating the fallback by skipping such a
session would lose genuine usage; a safe alternative needs a validated
session-to-directory index, not a guessed absence of work. Discovering new,
unrecorded daemon sessions always requires bounded discovery.
That verified-scoped-files fast path belongs only to `loadUsageHistory` with
an explicit id allowlist. `loadUsageHistoryWithLive` does not pass
`projectChatsDirs`: its unscoped discovery must still examine all project
`chats` directories in directory order so never-persisted work in another
project is not lost. A boundary-limited read therefore cannot
borrow a cached whole-transcript summary or make ordinary unrelated sessions
uncacheable.

Otherwise harmless empty calendar days do not require records, but unrelated
unrecorded transcripts still respect `LIVE_REBUILD_WINDOW_DAYS` whenever any
persisted history exists, including a run-only history. Only an empty history
uses the unbounded initial replay, while `sinceMs: 0` is the explicit escape
hatch. Partitioning durable records by runtime must not alter this decision:
an empty local subset still uses the unpartitioned history's bounded window and
does not become a new unbounded first migration. `loadUsageHistoryWithLive`
merges this recent daemon activity read-only,
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

**Known runtime roots own both transcripts and ledgers.** The daemon keeps each
root's records and ledger paired, applies coverage within that pair, and sums
the per-root token tables afterwards. Complete, identical response rows in
separate runtime ledgers are first deduplicated in memory using the full
per-response fingerprint; never by day, model or aggregate token counts.
The merge never modifies durable ledger files. It passes the transcript's explicit root
into replay rather than assuming that a pinned runtime context also changes the
global Qwen directory. The default global root is retained as a separate source,
including records whose runtime cannot be discovered. The source's extra scope
pairing is internal; the dashboard's JSON field shape is unchanged.

A durable record is assigned to a runtime only when its exact session and
project have one actual transcript file under that runtime's real
`SessionService` path. A missing or ambiguous match stays in the conservative
global source instead of being joined to a foreign runtime by session id. This
ownership check does not add project paths to ledger rows and does not infer a
per-request event join from matching dates, models or aggregate counts.
That candidate alone is likewise not permission to rewrite a conflicting
historical run. During per-root replay, durable records supply replay bounds,
but are carried separately from replay results into the strict consumption-key
consolidation. A differing ID or model-consumption tuple therefore remains two
real records even if only one actual transcript candidate survived. Exact
matching can still consolidate a defensible copy without reopening every
covered transcript. Within an established root, the ordinary compatible
reconstruction/reduction rules still apply, so an older snapshot is replaced
by a provably more complete later rebuild rather than added again. Records
with partial identities, or with the same scoped request IDs but conflicting
model-consumption fields, are held back for the strict identity comparison
rather than reduced by that ordinary path. This keeps compatible appended
history distinct from a 100-token versus 200-token conflict.

Copy consolidation is separate from ledger coverage and is restricted to the
same project/session and the same non-empty, unique, complete execution-id set;
the ID count must equal the record's model-request count. Model names and their
request, error, input, output, cache-read, reasoning and total-token counters
must also agree after model-name sorting; matching IDs with conflicting token
evidence remain independent. API and failure latency are observability to be
reconciled, not token-identity to be discarded. Supplements and unidentified or
partial records are never candidates. The global source is
preferred to keep ambiguous ownership with its ledger pairing. Existing
run/rebuild identity, tool/file and skill evidence governs the merge, retaining
better API latency and observability rather than deleting data just to make
counters match. Only a non-rebuild snapshot is temporarily marked run-scoped
for comparison; rebuilds retain their coverage rules, and original provenance
is restored before exposure or persistence. Within the same complete
consumption identity, durable non-rebuild copies can be folded across
non-overlapping writer windows, rather than forcing disjoint windows to
fabricate another API charge. This exception never merges disjoint ID sets,
different consumption counters or incomplete provenance. A selected older run that lacks
`successfulRequestExecutionIds` may inherit that array only when every defined
candidate array in the group has the same unique sorted contents. Conflicting
sets cannot manufacture a success list from all-request IDs or overwrite a
successful list present on the selected record. Absence therefore stays
conservative instead of becoming an invented identity. If the group
does not reduce to exactly one record, every original record remains. This
does not borrow another root's aggregate counters or infer identity from days,
models or totals; only the complete explicit-ID proof above may cross roots.

Each known-root ledger retains its runtime root even if replay finds no usable
transcript summary. That root is an ownership bound, not a wildcard. Its
transcript-path index is copied through ledger maps, preserving the guard that
an absent or ambiguous transcript cannot authorize a coincidental ledger copy.

**A session id is not a dedup namespace across projects.** Replay and persisted
run reduction preserve separate project/session pairs, even when equal ids or
windows occur in one runtime root. Within one project, directory-first replay
selection and the existing same-window counters/identity rules still apply.
Record projects therefore remain distinct inputs, not an event join inferred
from matching dates, models or aggregate totals. If a transcript cannot give a
valid project clock, file-level fallback keeps its identified supplements rather
than losing them to a session-wide first-wins rule.

Known-root ledger checks also use a private in-memory index of actual transcript
paths collected during the existing project enumeration; this adds no file
content reads or project field to the ledger. Multiple real paths for an id
cannot authorize one project's ledger to replace another project's run. A
run-scoped record or measured rebuild needs its expected actual transcript path
for replacement in an owner-aware legacy fallback. A missing transcript does
not itself veto an otherwise exact per-root execution proof, while a present
conflicting or multi-project transcript cannot authorize that proof.
Missing or ambiguous ownership keeps the independent records and ledger rather
than discarding consumption; the possible duplicate is the same explicitly
accepted limit as unknown legacy replay provenance, not a claim of perfect
deduplication. Directory entry metadata avoids an additional `stat` for ordinary
already-covered files. Without this index, the bounded legacy predicate remains
the compatibility fallback, not a universal event-identity claim.

The durable-history fast path must preserve this ownership too. It constructs
each eligible record's standard project/transcript path and retains it when the
file still exists, rather than enumerating every project. Scope lookup uses the
same raw-session keys as replay, while each path is derived from the record's
actual project and runtime root. Same-id paths from different projects are not
collapsed into one authorization; missing or ambiguous evidence stays
conservative. A `sinceMs` supplement exemption is separately bound to the
expected path plus the parsed real header's project/session key. A bare session
id may not exempt a same-id file from another project merely because its mtime
is old. Two different project keys sharing a sanitized expected path do not
authorize exemption for either project, rather than selecting whichever record
appeared last; a wrong real header at the expected path rejects that file as a
supplement. Missing project metadata supplies no path exemption. An explicit
`sinceMs: 0` still permits ordinary discovery, but does not turn a mismatched
header into ownership of the future run. These private path/key maps add no
project/path fields to ledger rows or dashboard responses.

The ledger's per-day/model identity index and raw-row merge are incremental:
lookup buckets are built once per table, and row arrays are cloned once and then
appended over the original source length, rather than copied again per merge.
When a known identity spans roots whose transcripts have unequal observability,
the merged record chooses the richest whole tool/file/skill payload per domain
instead of summing duplicate calls. When tool/skill totals tie, prefer the
copy with more complete `byName` count/success/fail observations; tools also
compare their name-specific duration totals. File payloads are compared by
total added+removed lines and retained intact, never by an additions-only
sort, a fieldwise synthetic union, or incidental root order. Each model retains its maximum observed
success/error latency, and the record's total latency is the sum of those
per-model values, consistent with metrics serialization. The authoritative
run clock is preserved too. No tool identity is invented: unknown legacy and
partial-identity observations still keep their disclosed conservative boundary.

**Project boundaries come from record content, not directory spelling.** The
replay reader chooses before/after/request-id filters from the parsed
transcript header's session id and cwd. It does not infer project ownership by
unescaping the project directory name, which may be a legacy alias. The replay
cache is partitioned by owning root: each root prunes its own aged/deleted
files without discarding another root's warm entries. File mtime/size, the
matching project scope and temporal boundaries still gate reuse, so only a
changed file needs another content read. Unscoped transient transcripts are
not marked as scoped projects merely because they have a cwd. The established
fast path may still skip a known, uniquely covered project/session's expected
transcript only after confirming that its cached mtime/size match the current
file; a newly appended covered transcript must be scanned again. Contrary
cached identity forces a fresh header read. That shortcut
does not bind a newly discovered cold transcript, whose actual header selects
the matching project filters. Once a header has been observed, a matching
project/session key is required for ordinary cache reuse. Durable candidates for another project supply only
that other project's window filters; they do not erase the cached actual
project key. A transcript whose actual project has no known window can therefore
hit a warm cache without borrowing the recorded project's bounds. A caller's
raw-session `beforeMs` is restricted to
its declared current project root; omitting that option preserves the legacy
caller-window behavior. The same project/session identity also governs both
deletion-salvage coverage checks, so one project's record cannot suppress
another project's transcript persistence. The ordered root cache retains the
64 most-recently-used roots. Eviction removes only reconstructible in-memory
summaries, never durable records, ledger rows or real files. Future ownership
does not globally disable this cache. An entry's private signature includes
the owned execution IDs and their bounded future windows. Changing or deleting
the owning snapshot therefore forces revalidation even when the stale summary
is `record: null`; unrelated project entries retain their ordinary warm path.
An entry without an observed project key supplies no future ownership proof.

**Conversation clock and ended-record clock stay separate.** A restored
conversation clock can be bound after the initial UI subscription; the
notification carries the target session id. The provider ignores that update
while another session id is active and applies the restored clock only when
`startNewSession(targetId)` commits the target id and its metrics together.
Legacy clock notifications without an owner retain their existing behavior.
Only an explicit `clockSessionId` marker (including an absent-owner value)
reads the telemetry store's clock as a clock update. Ordinary metric
notifications retain the provider's current clock instead of mixing a different
session's restored value into its snapshot. `resetLiveMetrics` and persisted run
starts retain the current-run clock.

When a root group has an authoritative run-scoped record with a valid clock,
cross-root consolidation restores its `timestamp`, `startTime`, `durationMs`
and provenance, even if a reconstruct offers richer response observability. A
malformed authority clock must not overwrite a valid reconstructed clock. If
the selected record's clock is also malformed, a valid native candidate can
supply it; if no valid alternative exists, the unknown clock is not replaced by
invented zero-time evidence. Provenance follows the authoritative run when it
exists, including an intentionally absent reconstruction flag. Run/session day
attribution therefore remains the real exit day, while token and API-request
day attribution remains the day of the actual response. A midnight test must
check those two calendars independently rather than forcing yesterday's ledger
into today's token bucket.

An identified run/run coverage reduction retains the richer whole skills
payload from the covered side; it never drops those observed invocations or
adds their counters to the covering run's distinct execution IDs.

Both live and ordinary history readers keep the full durable history for replay
ownership and for the decision that history exists. Each read captures one
`readAt`: replay ownership, the outer/inner root split and the ended/future
partition all use it. A non-finite persisted timestamp neither grants future
ownership nor truncates ordinary replay to an earlier run's start boundary, so
it cannot erase valid transcript evidence. A record exactly at the shared
instant is ended, neither
missing from both groups nor classified differently across roots. Non-finite
timestamps stay on the conservative durable side even when no transcript can
recover them, rather than failing both temporal tests or inventing a response
date. Ended-run cutoff applies only to returned/reconciled views, not to
initial migration or unrelated stale transcripts.

Matching future-owned API response/error IDs are excluded from replay even when
their events precede `readAt`. Finite future-owned windows are kept separately
by project/session rather than collapsed into one earliest-start/latest-end
interval. An independent API/tool observation between two owned runs remains
in the main reconstruction and advances its measured clock. Being inside an
owned interval does not by itself discard an independent response ID, even for
another model; only a known owned response may be suppressed. Tool evidence
outside every owned interval, or with disagreeing outer/inner clocks, is
independent of an earlier out-of-order owned response and must not be culled
with a supposedly tool-only replay. Before applying the
API-owned filter, calculation must say whether the event would actually enter
main reconstruction or a late supplement; excluded future rows cannot mark an
older independent tool history for deletion. Tool evidence before the known
future window's earliest start is retained independently of an API-owned
removal; only a residual purely owned tool-only copy without such independent
evidence is culled. Missing window/clock evidence is conservative. The private
marker never becomes a persisted field, and unresolved relationships retain
possible duplicates rather than invented per-tool identity. If a transient-file
header is malformed or out of order, reconstruction clamps the recovered start
to the valid end, yielding zero rather than a negative duration. An invalid
trailing timestamp falls back to the latest valid included row, then the
header, so measured tool/file activity is not discarded. Where a future run has
real response IDs and a finite end but an invalid start, a finite non-negative
duration may derive a start in `[0, end]`; that same bounded start governs both
ordinary replay inclusion and future-tool ownership. An identified future record without a bounded start cannot extend the
supplement cutoff past it, so an independently dated later response can still
be retained rather than lost between two deadlines. An invalid or unknown
row timestamp cannot prove future membership and is therefore not truncated by
that boundary. Without a valid window, matching tool counts alone are not an
identity, so an uncertain extra observation may remain instead of deleting
another run's genuine earlier work. An unreadable header must not discard
measurable usage: use only the earliest and latest valid timestamps of API
responses, API errors and tool calls actually accepted into reconstruction to
recover its clock. When no valid authoritative run supplies a clock, choose
the latest finite-clock native candidate; pure durable-copy reconciliation
uses the selected durable record's clock, never whichever root appeared
first. Unrestricted `all` aggregation retains consumption with non-finite
timestamps, while bounded date ranges do not assign those records to a
particular day by inference.

Only `runScoped === true` makes a future row an independently deferred delta.
It stays separate from older ended runs and is returned to its owning root
before exact cross-root consumption reduction. Other snapshots remain with ended counterparts before cumulative reduction.
When a plain future cumulative snapshot and an explicit run delta share a
project/session, the delta wins over its older copy; unrelated future
cumulative groups remain unchanged. A newer ordinary cumulative snapshot may
also provide full coverage only when it has a valid complete consumption key
of its own and `rebuildCoversRun` proves its start, request-ID superset,
per-model request/error/token counters and tool/file envelope cover the older
delta. A lower-consumption snapshot cannot discard the older real delta merely
because its IDs are a superset; an unresolved ordinary cumulative conflict is
retained conservatively beside that delta. If it really adds the other
response ID and its compatible consumption, that fuller snapshot and request
are not lost merely because the older delta exists. Such proof is not generic
last-wins: disjoint IDs, weak or conflicting consumption and legacy records
without their own complete identity remain separate. Native reconstructions are judged by
their own coverage rules rather than being removed merely because that delta
exists. ID presence alone is not run-delta provenance. The replay-only option
returns no such persisted future snapshots, although their identities still
bound replay. Rebuild/session ownership is never inferred from Day/Model totals.
Invalid ID members are ignored individually; valid siblings still establish
ownership, and non-array shapes are ignored for ownership without crashing
history reads. A malformed owner object is isolated while loading durable
JSONL rather than coerced into a session/project key; valid sibling rows still
load. Supplements keep their explicit exemption and no read rewrites
the durable history.

A same-day run ending after the read is excluded from ended sessions, tools and
its session-record tokens. This field-level cutoff does **not** delete a
successful-response ledger row: that row is already evidence of real API
consumption, not an ended-run attribution. Thus a future-ended run with a real
100-token ledger response still contributes 100 tokens and one request to
summary/daily tokens, while its sessions/tools remain zero. A transcript
supplement likewise contributes actual API tokens without inventing an ended
run. When the durable record itself is the only direct evidence of that real
response, its unknown-ledger token/request fallback also remains; that still
does not create an ended session or tool metrics before `readAt`. Established
calendar-day windows are unchanged; clock disagreement cannot erase real usage
merely to make every tile zero.

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
fields. The original transcript root/path scope stays attached to the persisted
array; project/session keys are rebuilt **after** the live record is merged.
Without that ordering, another project's same-id history can be erased by the
active request's ledger. This remains private WeakMap metadata, not a project
field added to ledger/dashboard JSON. The original live record also reaches
`buildUsageDayTable`, so only it can use its complete request identities for
exact coverage when no successful-ID list has been persisted.

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
- **The ledger counts real API-token consumption, including internal helper calls.**
  With usage statistics enabled, `logApiResponse` records the tokens of every
  actual response it receives, including `prompt_suggestion`, `forked_query`,
  `speculation` and `side-query:*`. Those hidden prompt contents still do not
  enter the transcript. Reporting a run's aggregate while omitting its side
  queries could otherwise delete a real response whenever the ordinary part
  had ledger coverage. Older rows that omitted internal calls cannot be
  repaired by guessing their event identities from days, models, counts or
  aggregates. Calls filtered before `logApiResponse`, a disabled usage-statistics
  preference and best-effort storage failures remain outside this guarantee.
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
  `id` and telemetry `execution_id` remain separate identities. An absent
  `runScoped` flag does not prove that a record is a replay copy. Where session
  metadata is available, a session absent from the ledger must not be
  reclassified as another session's spend merely by a shared day and model.
- Ledger writes are gated by `config.getUsageStatisticsEnabled()`. Internal
  prompt ids suppress chat transcript recording, not token accounting; best-effort
  storage still cannot promise that every response reached disk.
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
- **Directory scope.** The route reads each known runtime's transcript root
  and ledger root as one source, plus the default global CLI source. Roots are
  canonicalized where possible. Trailing-separator spellings are eliminated.
  When the filesystem reports a directory's dev/inode identity, that identity
  also deduplicates symlink and case-spelling aliases without coalescing
  distinct case-sensitive directories; unverifiable identities are not
  force-merged by letter casing. With different realpaths sharing one
  dev/inode identity, the first confirmed canonical representative is retained
  for the pass, so a later alias cannot split the scope again. Coverage
  happens inside each paired source, not across roots. A shared durable history
  is read once; an exact session/project recording is paired only with its
  unique actual transcript path, while missing or ambiguous ownership stays
  global. Unresolvable roots keep the existing per-root fallbacks rather than
  aborting the response or aliasing into ambient runtime. No ambient-runtime
  ledger is substituted for a known workspace, and global/unmapped records are
  not discarded. A relative transcript root can
  therefore provide sessions, tools and file changes even with its own token
  ledger disabled, without treating an unrelated runtime as its source.
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
  keys on `sessionId`, project and the run window without touching what any
  writer uses as its identity. The pre-deletion salvage and persisting migration still write
  cumulative event-time reconstructions. They suppress only an already covered
  transcript, and explicit reconstruction provenance preserves disjoint history
  beside per-run deltas.
