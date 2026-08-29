# Selective session restore

- Status: Draft for review
- Tracks: #8678
- Prerequisite status on 2026-08-12: #8691, attachment-identity hardening in
  #8833, transactional cross-session switching in #8882, and exact-shape
  restore coalescing in #8933 are merged; selective implementation may start
  from fresh `main` containing merge commit `962dc8e`

## Scope and ordering

Issue #8678 orders four implementation slices: timeout safety in #8691,
transactional WebUI session switching, bounded UI history hydration, and the
durable checkpoint. This document uses selective runtime projection to implement
the bounded-hydration slice without leaving full runtime materialization in
place.

PRs #8691, #8833, and #8882 have merged. The original transactional prototype in
#8824 was closed and split into those narrower ownership and switching slices.
The final #8882 implementation keeps the current UI session attached until a
fully staged target wins its identity, environment, lifecycle, and deadline
checks and commits. Review after merge found one remaining correctness boundary:
the WebUI coordinator and ACP bridge could still coalesce non-equivalent replay
requests. Merged PR #8933 implements exact-shape coalescing, page snapshotting,
bridge ingress validation, and the associated unit and real-daemon regression
coverage. Selective implementation begins from fresh `main` containing #8933
and must not duplicate that coordinator or bridge fix. The boundaries are
distinct: #8691 fences timeouts and late results; #8833 fences stale attachment
work; #8882 owns transactional target commit; #8933 owns restore request-shape
correctness; selective restore removes the leased mode's duplicate full read and
reduces reconstruction, materialization, and replay cost but does not replace
transactional commit semantics or make a slow restore responsive by itself. The
lease-off path still scans the frozen transcript once.

#8883 repairs retry after the existing watchdog expires on the legacy switching
path. It is related but is not an implementation prerequisite for selective
restore. Same-logical-session resync/repair and branch adoption remain separate
PR3c/PR3d ownership work and are also outside this slice.

This design PR changes no runtime behavior and does not close #8678.

## Context

The daemon restore path currently materializes a persisted transcript before it
can use either the model state or a bounded history page:

1. `loadCliConfig()` calls `SessionService.loadSession()` and reads the complete
   JSONL transcript before constructing `Config`.
2. When chat recording and the experimental session-writer lease are both
   enabled, `Config.initialize()` acquires the lease and calls
   `SessionService.loadSession()` again to obtain an authoritative copy. The
   lease is disabled by default; when the recorder will not acquire it, the
   first full load is consumed directly.
3. `GeminiClient`, `ChatRecordingService`, `GoalRuntime`, the ACP `Session`, file
   history, artifact restoration, and history replay derive their state from the
   resulting full `ResumedSessionData.conversation.messages` array.
4. `historyPageSize` is applied only after that array exists. It bounds the
   replay response count, not cold-load parsing, materialization, or retained
   payloads.

`SessionTranscriptReader` already provides most of the lower-level mechanism we
need. It scans a frozen transcript snapshot once, stores UUID/parent/segment
metadata, reconstructs the active chain, reads selected records by byte offset,
supports backward pages, and enforces the existing 256 MiB index cap, 4 MiB soft
page budget, and 16 MiB bounded expansion ceiling. The missing piece is one cold
restore projection that serves all runtime consumers without first constructing
the full conversation, plus a narrow live-attach projection backed by the same
index machinery.

## Goals

- Replace daemon cold-load/resume full materialization with one frozen
  transcript snapshot scan. When chat recording and the writer-lease protocol
  are both enabled, that scan occurs after lease acquisition and is
  authoritative; otherwise preserve today's unfenced consistency model without
  retaining the full conversation.
- Materialize only records required for runnable model state, recorder state,
  resume-critical services, and the requested initial replay page.
- Bound an explicitly paged initial replay by both record count and source bytes.
- Preserve exact active-branch, rewind, fork, side-task, history-gap, compression,
  file-history, artifact, goal, attribution, usage, and interruption semantics.
- Preserve full visible replay for older clients that omit `historyPageSize`.
- Fail a cold daemon restore over the existing 256 MiB transcript-index limit
  with a structured request-scoped `413 transcript_too_large`; never fall back
  to the old full-materialization loader.
- Treat that 256 MiB daemon restore limit as an intentional compatibility change
  requiring maintainer approval: the old loader attempted larger transcripts,
  while the new path fails them predictably instead of taking the least-bounded
  path.
- Treat the new 32 MiB transformed-replay ceiling for explicitly paged bulk
  loads as a second intentional compatibility change requiring maintainer
  approval. Source paging was already bounded, but a highly expanding page that
  previously reached the client may now fail before transport.
- Reuse the existing REST and SDK pagination surface:
  `historyPageSize`, `historyHasMore`, `historyAnchorRecordId`, and transcript
  cursor paging.
- Extend #8691 restore tracing so operators can distinguish index construction,
  state reduction, selected reads, replay, and post-replay initialization.

## Non-goals

- A durable resume sidecar or checkpoint. Without one, cold restore still scans
  the transcript once and remains O(file bytes).
- Making restore proportional only to the JSONL tail. That is the checkpoint
  follow-up.
- Implementing transactional WebUI session switching or restore-shape
  coalescing. #8833 owns attachment identity, #8882 owns the
  restore/stage/guarded-commit boundary, and #8933 owns exact-shape admission.
  This design does not change attach, detach, WebUI commit ownership, or the
  legacy detach-first fallback when `client_identity` is explicitly
  unavailable.
- Changing TUI `--resume`, `--continue`, session export, archive reads, fork, or
  branch behavior.
- Changing the standalone legacy `qwen/session/loadUpdates` extension or the
  post-rewind artifact refresh. They are not on the `session/load` or
  `session/resume` incident path and remain follow-up migrations.
- Changing daemon features that independently request complete persisted content,
  including live-task read/wait/startup lookup and realtime startup-context
  construction. They are not downstream consumers of the ACP restore result;
  replacing their full-content reads needs a separate consumer contract.
- Changing the public `ResumedSessionData` contract used by non-daemon callers.
- Adding new REST or TypeScript SDK response fields.
- Guaranteeing a machine-independent latency threshold for an 80 MiB fixture.

## Compatibility constraints

The implementation must preserve these behaviors even when they require more
data than the recent UI page:

- Model history uses the active-branch `chat_compression` candidate selected by
  the exact current `buildApiHistoryFromConversation()` predicate plus its tail.
  A truthy malformed `compressedHistory` keeps the current restore failure; this
  design does not add fallback to an earlier checkpoint. If no candidate is
  selected, the complete active model-facing history must be read. Selective
  restore cannot safely truncate the model context of an uncompressed legacy
  session.
- Runtime history includes inherited fork/side-task context needed by the model.
  UI replay may hide inherited records. These are different projections of the
  same active chain.
- `/rewind` needs every surviving user-turn parent UUID, even when the
  corresponding record payload is not materialized.
- File-history restoration must reproduce the current last-write-wins behavior
  and the final 100-snapshot cap.
- Artifact reconstruction must include only artifact side records attached to
  the active branch and must exclude abandoned rewind branches.
- Goal recovery must keep the existing precedence exactly: scan newest to oldest
  for the newest valid v2 lifecycle snapshot even when newer v2 records are
  malformed; if no valid v2 exists but any lifecycle record is malformed or
  unsupported, return the existing unsupported recovery and do not fall back to
  legacy goal cards.
- A missing parent remains a visible history gap. The loader must never reconnect
  an earlier physical record and resurrect a rewound-away branch.

## Proposed architecture

### One cold restore projection

Add a daemon-oriented projection API to `SessionTranscriptReader`, wrapped by
`SessionService` so project membership and active/archive ownership checks remain
centralized:

- `SessionService.readRestoreProjection(sessionId, options)` performs a cold,
  request-local fresh scan and is the only selective cold entry point. It
  returns `undefined` only when the frozen file has no parseable active record,
  preserving the current empty-session result without manufacturing resume
  state. Project-membership or snapshot-validation failures remain errors, not
  empty-session fallbacks.
- `SessionService.readLiveRestoreProjection(sessionId, operation)` may reuse the
  existing index cache and returns only the replay/artifact state needed by a
  live load or resume.

Callers do not choose cache freshness and do not pass a matrix of consumer
flags. The two entry points encode the only two ownership/lifetime contracts.

```ts
interface SelectiveSessionRestoreOptions {
  replay:
    | { kind: 'none' }
    | { kind: 'all'; hideInheritedHistory: boolean }
    | {
        kind: 'recent';
        limit: number;
        hideInheritedHistory: boolean;
      };
}

interface SessionRestoreProjection {
  sessionId: string;
  filePath: string;
  startTime: string;
  lastUpdated: string;
  runtime: SessionRuntimeResumeState;
  replay?: SessionRestoreReplayPage;
}
```

Cold restore has two acquisition modes but only one projection and one reducer:

```ts
type SessionRestoreProjectionSource =
  | {
      kind: 'preloaded';
      projection: SessionRestoreProjection | undefined;
    }
  | {
      kind: 'after_writer_lease';
      options: SelectiveSessionRestoreOptions;
    };
```

`preloaded` is used when chat recording or the startup-frozen writer-lease
protocol is disabled. `loadCliConfig()` builds one fresh frozen projection
before constructing `Config`, matching the current lease-off consistency
contract. `after_writer_lease` is used only when the recorder will acquire a
lease; `Config.activateChatRecording()` builds the projection after acquisition.
The implementation must not silently fall back to the old loader in either
mode, and must not enable the experimental writer protocol as a side effect of
this feature.

`loadCliConfig()` already has a long positional signature. Carry the projection
source in one final named host-options object for runtime-only embedding inputs,
alongside the existing host policy, rather than adding another positional
parameter. Ordinary CLI callers omit that object or leave the projection field
unset.

These snippets describe internal semantic and ownership boundaries, not a
required one-declaration-per-block API or a public daemon protocol contract. The
implementation should inline or merge single-use shapes and export only types
that cross the core/CLI boundary, while preserving the distinctions between cold
and live results and between preloaded and post-lease acquisition.
`ResumedSessionData` stays unchanged for TUI, export, archive, fork, and other
existing callers.

`SessionRuntimeResumeState` contains reduced, consumer-specific state rather
than a partial object pretending to be a full conversation:

```ts
interface SessionRuntimeResumeState {
  apiHistory: Content[];
  resumeTokenCounts?: ResumeTokenCounts;
  uiTelemetryEvents: UiEvent[];
  attributionSnapshot?: AttributionSnapshot;
  historyGaps?: HistoryGap[];
  recording: {
    lastCompletedUuid: string;
    turnParentUuids: Array<string | null>;
    customTitle?: string;
    titleSource?: TitleSource;
    parentSessionId?: string;
    sourceType?: string;
    sourceId?: string;
  };
  fileHistorySnapshots?: FileHistorySnapshot[];
  artifactSnapshot?: RebuiltSessionArtifactSnapshot;
  goalRecords: GoalRecoveryRecord[];
  goalCheckpointWindow?: GoalEvidenceCheckpointWindow;
  initialTurn: number;
  backgroundNotificationTaskIds: string[];
}
```

The concrete implementation may regroup fields or derive them from existing
index hints where that is simpler, but it must not reuse `conversation.messages`
for a selective subset. A type whose name implies completeness must remain
complete. `backgroundNotificationTaskIds` remains an eager reduced field because
`Session` needs it during initialization; do not retain or expose the transcript
index to derive it later.

`SessionRestoreReplayPage` carries the selected records and existing replay
metadata before ACP updates are generated:

```ts
interface SessionRestoreReplayPage {
  records: ChatRecord[];
  gaps: HistoryGap[];
  hasMore: boolean;
  anchorRecordId?: string;
  replay?: unknown;
}
```

Live attach must not manufacture an unused `SessionRuntimeResumeState`. Add a
narrow sibling result backed by the same reader/index internals:

```ts
interface SessionLiveRestoreProjection {
  sessionId: string;
  startTime: string;
  lastUpdated: string;
  replay?: SessionRestoreReplayPage;
  artifactSnapshot?: RebuiltSessionArtifactSnapshot;
}
```

`SessionService.readLiveRestoreProjection()` selects replay plus artifact state
for live load, or artifact state only for live resume. This is a second
consumer-specific result, not a second scanner or index and not a generic matrix
of optional runtime flags.

### Projection ownership and release

The cold projection is one-shot initialization state, not a new lifetime cache.
`Config` may hold it while recorder, Goal, telemetry, attribution, Gemini, file
history, and ACP state are initialized, but consumers should use one-shot
accessors or an equivalent explicit handoff. File-history transcript records are
eagerly reduced into the capped snapshot state during projection. After the
response-mode replay envelope has passed its limits,
`createAndStoreSession()` must force the existing lazy service owner to consume
that state during its existing setup sequence and before the final release. This
is runtime service hydration, not a second transcript read.

After complete response construction and successful Session creation:

- `Config` retains no `apiHistory`, normalized `goalRecords`, UI telemetry
  array, replay `ChatRecord[]`, or artifact reconstruction input from the
  projection;
- Gemini/recorder/Goal/file-history/Session retain only their normal operational
  state;
- the ACP agent retains only the response envelope until the load response is
  returned; and
- the transcript cache retains index metadata and segments, never selected
  record payloads.

Failure cleanup and `Config.startNewSession()` clear any pending projection as
well. A same-process `/clear`, `/new`, or later session transition must never
reuse the previous session's reduced state. This release discipline is part of
the memory fix, not optional cleanup.

### Index extensions

Extend the existing `TranscriptIndex`; do not build a second index type or a
second scanner.

The index keeps two UUID sequences:

- `runtimeUuids`: the complete active `parentUuid` chain, including inherited
  records required by the model.
- `replayUuids`: the visible active chain. Side-task source boundaries always
  hide inherited parent records; ordinary fork history is filtered only when
  the caller requests `hideInheritedHistory`.

Derive the authoritative side-task source boundary from `runtimeUuids` after the
active chain is known. A single "last physical session source" scalar is
incorrect because a later abandoned branch may contain its own source record.

Each indexed record continues to retain only bounded metadata and physical
segments. Add small projection hints required to choose records after the active
chain is known:

- compression candidates and assistant usage candidates;
- UI telemetry and attribution positions;
- user-turn boundaries and prompt-turn hints;
- background notification task ids;
- active parent-session and session-source positions;
- goal-state and legacy goal-status candidates;
- normalized Goal-evidence eligibility, lineage context (including malformed-
  context and turn-reentry error markers), bounded preview, proof kind, and
  catalog-byte contribution, but not evidence content;
- file-history record positions;
- artifact side-record metadata and physical order.

Large message, tool result, snapshot, and artifact payloads remain represented
by byte segments until selected. Tolerant parsing, fragment aggregation, cycle
detection, missing-parent diagnostics, snapshot identity checks, and cache
accounting stay shared with transcript paging.

The scanner must validate that the first record belongs to the resolved
workspace and that selected records belong to the requested session. Mixed
session ids, changed segments, or an unavailable frozen snapshot fail the
request rather than returning a plausible but incorrect projection.

Keep transcript-proportional work cooperative on the shared ACP child. The
shared full-scan primitive tracks both source bytes processed and elapsed
monotonic processing time. After it finishes the current physical JSONL line,
it awaits `setImmediate` when either fixed internal budget is exhausted, then
resets both budgets. The selected-record dispatcher uses the same policy after
dispatching a complete aggregate because no-compression model history can also
make selected work transcript-proportional. These are internal scheduling
constants, not settings or protocol fields; use the large-session benchmark to
tune them without adding a machine-specific latency gate. This preserves one
scan and every reducer boundary while allowing timers, sibling prompts, and I/O
callbacks to run between records.

Cooperative scheduling cannot preempt the synchronous parse and validation of
the current physical line. An approximately 2 MiB JSON record therefore remains
one indivisible `JSON.parse` interval. Moving parsing to a worker or introducing
a streaming JSON parser is a separate complexity tradeoff and is not part of
this slice; report this residual explicitly rather than claiming a hard
event-loop-lag bound.

A writer-leased cold restore must not reuse an index whose build began before
lease acquisition. It builds a fresh index inside the lease transaction, uses
that same object for runtime and replay selection, and may offer the completed
index to the existing cache for later transcript pages. A lease-off cold restore
also builds one fresh frozen index, but cannot claim writer authority; this is
the same concurrency guarantee as the existing lease-off loader. Live and
read-only transcript requests may continue to use the normal cache.

The projection captures the file identity, size, and mtime before scanning and
rechecks the same signature after selected reads and the bounded title lookup. A
lease-off concurrent append therefore fails the request and can be retried
instead of registering a mixed snapshot; the remaining instant after that check
retains the unavoidable legacy race of running without writer fencing. The
leased mode additionally uses the lease's final unchanged assertion.

Keep that fresh index request-local until selected-record validation, the final
file signature check, and the leased-mode unchanged assertion all succeed. Only
then make a non-clobbering cache offer. If the same cache key already has a
completed value or pending build, or admission would require evicting an
existing value, skip the offer. Normal cached builds keep their existing
coalescing and LRU policy, but pending completion and rejection must update or
delete the cache entry only when the entry still identifies that pending build;
an evicted or superseded pending promise must not overwrite or delete a newer
value.

Projection hints that duplicate existing interpretation logic must use shared
helpers rather than reimplement it in the scanner. In particular, prompt-turn
hints must use the exact `record.promptId` plus UI-telemetry `prompt_id`
semantics currently used by `computeInitialTurnFromHistory()`. Hint arrays
should live on the existing per-UUID entries where possible so dead-branch
filtering and cache accounting do not create parallel unbounded indexes. Every
newly retained piece of index metadata must also extend
`estimateIndexCacheBytes()`, including container, key, value, and base-object
overhead. An index whose own estimated size exceeds the entire cache byte budget
may serve requests sharing its in-flight build, but its completed value must not
be retained. Completed-value byte-budget admission must not evict an
already-cached value; existing pending coalescing and entry-count or aggregate
LRU behavior remain unchanged.

### Runtime state selection

After constructing the active chain, select and read the union of required
segments once:

1. **Model history.** Choose the active compression record using the exact
   current `buildApiHistoryFromConversation()` selection predicate and all
   active non-system messages after it. If no candidate is selected, choose
   every active model-facing record. Feed the selected payload through the
   existing copy path so a truthy malformed `compressedHistory` fails exactly as
   it does today rather than falling back to an earlier checkpoint. Apply the
   existing mid-turn merge, realtime exclusion, and copy semantics so the result
   remains the exact input to existing interruption recovery.
2. **Telemetry.** Read active UI telemetry records, reduce the latest resume
   token counts, and read only the latest active attribution snapshot. Apply the
   events through the existing session reset/add/set helper so selective input
   does not lose `uiTelemetryService` side effects.
3. **Recorder.** Derive `lastCompletedUuid`, every surviving user-turn parent,
   active lineage/source metadata, and turn numbering from index hints. Resolve
   title and title source with the existing bounded tail-then-head title picker,
   under the lease when enabled, rather than changing legacy title visibility by
   treating the full index as a new title search surface.
4. **Goal.** Select the active goal-state candidates needed by
   `recoverGoalFromRecords()` plus the slash-command records containing legacy
   goal-status cards. The latter preserve iteration count, start time, the last
   terminal-goal cache, and current `restoreGoalFromHistory()` behavior.
   Normalize them into minimal `GoalRecoveryRecord` values in chronological
   order rather than retaining complete slash-command payloads. A valid v2
   record keeps its parsed lifecycle payload; a malformed v2 record keeps only
   the fields needed to reproduce the unsupported result; a legacy result keeps
   only raw `goal_status` candidates, including malformed candidates whose
   position can affect recovery. Discard unrelated slash-command history items.
   Broaden the existing collection helper to accept this structural record type
   so both production reducers consume the same normalized inputs without a new
   Goal precedence implementation. Preserve the source UUID of every normalized
   candidate and have the shared reducer identify the record that determines the
   recovered state. The replay bootstrap can then test that source UUID against
   the selected replay UUIDs instead of duplicating Goal precedence. The same
   records also drive the recent-replay goal bootstrap described below. A v2
   state with a pending checkpoint is an additional restore consumer: today its
   asynchronous recovery calls `readActiveTranscriptChain()` and re-enters the
   old full loader. Extract a bounded Goal-evidence selector and accumulator
   shared with `buildGoalEvidenceCheckpointWindow()`. After Goal recovery
   identifies the pending permit and cursor, run the selector over active-chain
   evidence hints to reproduce the existing newest-entry, catalog-byte, lineage,
   malformed-context, turn-reentry, and truncation decisions without retaining
   evidence content. Add only the selected evidence UUIDs to the union, then feed
   their materialized records to the shared accumulator and retain the resulting
   window in the projection. This two-stage selection must preserve the existing
   production helper's valid result. When its evidence source is unavailable or
   invalid, omit the projected window so deferred Goal activation falls back to
   the existing runtime path and its established degradation behavior instead of
   rejecting the whole session restore. It must not select every active record,
   perform a second scan, or copy Goal precedence. Deferred Goal activation
   consumes a valid projected window instead of reading the transcript again.
5. **File history.** Read every active `file_history_snapshot` record in
   chronological order and feed each batch through the existing whole-batch
   deserializer. This preserves today's behavior where one malformed item skips
   the entire record. Apply last-write-wins replacement while preserving each
   prompt id's first insertion position, then retain the final 100 snapshots.
   The reader cannot safely choose only the final 100 records in advance because
   prompt ids and batch validity live inside JSON payloads. Under the current
   synchronous file-history initialization contract, active file-history
   payloads are a required selected-read cost for this slice. Preserve the
   current service gate: when file checkpointing is disabled, do not hydrate or
   validate the reduced snapshots, and release that projection field with the
   other one-shot payloads.
6. **Artifacts.** Run the current active-side-artifact selection semantics over
   lightweight physical metadata, including the existing adjacency and blocker
   rules, then read every artifact snapshot/event record selected by that rule
   and call the existing reducer in physical order. Extract a stateful internal
   accumulator and make the current batch reducer call it as well, rather than
   implementing a second artifact state machine. Do not jump straight to the
   latest snapshot: malformed-record warnings, stale-sequence handling, and
   fallback to an earlier valid snapshot are part of the current result.
7. **ACP state.** Compute initial turn with the shared prompt-id interpretation
   helper and collect persisted background notification task ids from active
   metadata without materializing unrelated payloads.

Deduplicate the UUID union before opening the file and process UUIDs in the
logical order required by their consumers. For each UUID, read its segments in
physical-offset order, aggregate that one record, dispatch it, and release it
before moving to the next UUID. A fixed, tiny glued-line cache may share an
already-read physical line across adjacent UUIDs. Do not globally sort all
selected segments, retain multiple unfinished record accumulators, spill to a
second store, or rescan the transcript merely to optimize seek order. One UUID
needed by multiple consumers is aggregated once, peak assembly state is at most
one in-progress aggregate record plus the bounded line cache and the declared
final projection outputs, and every selected segment/line is read at most as
allowed by that cache policy. Explicitly recent replay output is bounded; legacy
`all` replay and uncompressed model history remain the documented compatibility
outputs rather than being hidden by the assembly-state claim.

The selected-read executor must dispatch each aggregated record to its consumers
without first constructing a catch-all selected `ChatRecord[]`. Retain payloads
only when the final projection actually needs them: model-facing `Content[]`,
normalized minimal `goalRecords`, and the requested replay records. In
particular, never retain unrelated `slash_command.outputHistoryItems` merely
because the same record contains a legacy Goal card. File-history batches are
reduced immediately into the capped snapshot state, and artifact records are fed
through an incremental form of the existing reducer so the projection does not
hold both the complete artifact event list and the rebuilt snapshot. Fragment
assembly may retain the segments for the record currently being aggregated, but
must not become a second transcript-sized payload cache. This streaming dispatch
is required for the peak-memory goal; "one read" alone is insufficient.

### Replay selection

For `replay.kind === 'recent'`, use the same backward selector as the transcript
endpoint:

- caller record limit, currently 100 from Web Shell by default;
- 4 MiB source-byte soft budget;
- bounded turn and tool-pair alignment;
- 16 MiB source-byte hard expansion ceiling;
- `hasMore` plus an anchor for the next backward page.

For `replay.kind === 'all'`, read the full visible chain. This path exists only
for compatibility with clients that omit `historyPageSize`; it intentionally
preserves their current unbounded visible replay semantics while still avoiding
dead-branch payloads and the duplicate full-file read.

For `replay.kind === 'none'`, used by `resumeSession`, do not materialize UI
records.

Map protocol modes explicitly:

| ACP restore request                       | Projection replay kind |
| ----------------------------------------- | ---------------------- |
| bulk/response load with `historyPageSize` | `recent`               |
| bulk/response load without the field      | `all`                  |
| legacy streamed load                      | `all`                  |
| `resumeSession`                           | `none`                 |

Merged PR #8933 implements bridge restore-shape normalization before
`inFlightRestores`. Omission remains `{ kind: 'all' }`; an explicit validated
page size is `{ kind: 'recent', limit }`; resume is `{ kind: 'none' }`. The
coalescing key also includes action, response/stream replay mode, and
`hideInheritedHistory`. Only identical discriminated shapes coalesce. Omitted
versus explicit page size, or two different explicit limits, returns the
existing `restore_in_progress` conflict instead of receiving the first request's
replay page.

#8933 also updates #8882's outer WebUI transition coordinator to use the same
request-equivalence boundary before a restore reaches the bridge. It snapshots
the operation and effective page size when the intent is created and includes
the resulting `load/all`, `load/recent(limit)`, or `resume/none` shape beside
normalized session and workspace identity. Exactly identical target and replay
shapes may share one public intent. A newer non-identical shape follows #8882's
supersede-and-serialize lifecycle and permanently fences the obsolete raw result,
even if a later intent returns to its shape; a timed-out raw request that has not
been superseded by a different shape may still satisfy an exact-shape retry
within the same lifecycle. An explicit lifecycle cancellation fences the old raw
result even if a later intent requests the same shape.
Selective restore must consume this completed boundary rather than add a second
coordinator or caller-owned shape matrix.

At bridge ingress, #8933 validates meaningful response-load `historyPageSize`
values with the REST/ACP integer range before live-entry lookup, admission, or
coalescing. Streamed load and resume normalize to their existing `all`/`none`
shape even if a direct programmatic caller supplies the otherwise unused field.
The REST route retains `400 invalid_transcript_limit`; meaningful invalid direct
bridge values receive local input validation. The normalized field is also used
for live lookup, so residency cannot change its meaning. #8933 corrects the
stale `BridgeRestoreSessionRequest.historyReplay` comment: omission defaults to
streamed load, not bulk response. Selective implementation retains these tests
and adds only the projection-mode mapping and limits behind the established
shape.

Classify every production restore caller by whether it consumes replay. Do not
use compatibility-mode `all` merely to make a runtime resident:

| Caller                                                                                        | Required restore shape                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebUI REST load after #8882                                                                   | `recent(100)` or the explicit requested limit                                                                                                            |
| Generic REST/ACP HTTP/WS `session/load` with no page size                                     | `all`, preserving public compatibility                                                                                                                   |
| Branch/side-task load that returns inherited/branched history                                 | `all` or its explicit recent request                                                                                                                     |
| Scheduled-task startup rehydration and keepalive revival                                      | `none`; use bridge `resumeSession()` because the result ignores replay                                                                                   |
| Direct and daemon-backed channel `SessionRouter` restoration                                  | `none`; keep the router's `loadSession` abstraction if useful, but implement it with ACP/SDK resume because neither adapter consumes the replay snapshot |
| Parent notification recovery, live task/coordinator recovery, and sub-session parent recovery | Existing `resumeSession()`/`none` behavior                                                                                                               |

Tests must prove scheduled-task rehydration still restores cron/Goal runtime
state, while both channel adapters remain promptable and receive post-resume
live updates, including the available-command refresh they currently learn after
registration. None may collect historical replay frames. Standalone
`qwen/session/loadUpdates`, session export, and callers explicitly asking for
prior UI history retain their documented full-read behavior outside this
migration.

Keep `qwen.session.loadReplay` at internal envelope version 1 and add optional
`anchorRecordId?: string`. The agent sets it to the oldest selected active
record when an earlier page exists; the bridge validates and strips it from
metadata, stores it on the entry, and uses it only after actual update/marker
record ids as the fallback for the already-public `historyAnchorRecordId`. No
REST or SDK request or response field is added.

### Recent replay state bootstrap

Recent paging may start after the record that established a still-active goal.
Restoring the Goal runtime or legacy Stop hook without showing that goal in the
client creates a split-brain state: the loop is active but the UI says it is
not. For a recent initial replay, reduce the normalized `goalRecords` with the
existing v2 and legacy goal reducers. If the state-determining active-goal record
is older than the selected page, emit one synthetic current-goal bootstrap update
before the page updates. It may carry source provenance, but it must be
non-paginable and must not replace the explicit oldest-page anchor. If policy
refuses to restore the goal, apply the existing `supersedeUnrestorableGoal`
clearing rule after the bootstrap. Do not emit a bootstrap when the selected page
already contains the state-determining record, and do not synthesize terminal
goals that pagination intentionally omitted.

This is ACP presentation state only. It does not append a transcript record and
does not replace either production goal reducer. When v2 and legacy records
interleave, the bootstrap must match the final goal presentation produced by a
full `HistoryReplayer`; the implementation must not invent a separate precedence
rule.

### Serialized bulk replay limit

The current 32 MiB ceiling is local to the REST transcript-page serializer. ACP
`qwen.session.loadReplay` already rejects more than 10,000 updates, but that
validation happens after the agent has built and transported the envelope and
there is no equivalent byte limit. Put the 32 MiB and 10,000-update internal
protocol constants in the bridge types shared by agent, bridge, and REST
serialization. Enforce both bounds while building an explicitly recent bulk
replay, before the ACP response crosses the child pipe. The REST transcript
route continues to enforce its complete-page serialization limit independently.

Source-byte selection is not proof that transformed ACP updates fit: escaping,
tool projection, and one source record producing many updates can exceed either
bound. Count the goal bootstrap and every synthetic/finalization update. If the
transformed recent envelope exceeds its byte or update-count cap, fail before
`createAndStoreSession()` with ACP
`errorKind: transcript_page_too_large`, which the daemon REST layer maps to
`413 transcript_page_too_large`. Do not build an unbounded envelope first, do
not register a runtime that the caller was told failed, and do not add a second
turn/tool-alignment algorithm to trim transformed updates.

Use one serialization per update for incremental accounting, then perform one
final exact UTF-8 `JSON.stringify()` check on the bounded
`qwen.session.loadReplay` value. The budget includes `v`, the update array and
its delimiters, `hasMore`, `partial`, `replayError`, `anchorRecordId`, goal
bootstrap, and every synthetic/finalization update. Exactly 32 MiB and exactly
10,000 updates are accepted; the first extra byte or update is rejected. This
is a replay-envelope limit, not a claim that the complete outer JSON-RPC frame
is exactly 32 MiB.

The limit guard must preserve a dedicated internal typed error carrying
`reason: 'bytes' | 'updates'`, observed value, and limit through replay
conversion. The existing collector catches
ordinary projection/emitter failures and returns `partial`/`replayError`; a
byte- or update-limit exception must bypass that compatibility downgrade and
remain a terminal request error. Implement this with a bounded collector or an
explicit typed rethrow, not by matching an error message after the type has been
discarded.

Tests must cover collective byte/count expansion where every individual record
fits but the envelope does not. Full replay selected because `historyPageSize`
was omitted keeps its existing compatibility semantics, including the existing
10,000-update validation; this PR must not quietly impose the new byte cap on
that legacy mode.

### Oversized transformed replay

An individual record or a collectively expanding recent page that exceeds the
post-transformation cap returns the same request-scoped
ACP `transcript_page_too_large` contract as an oversized transcript page; the
daemon REST mapping is 413. The Config is cleaned up, the session is not
registered, no replay record is appended, and sibling sessions remain usable.
The expected legacy Goal migration described below may already have appended its
single v2 `goal_state` during Config initialization; that existing resume-side
normalization is the only permitted transcript mutation before this failure and
must invalidate the projection cache normally. For collective expansion, an
explicitly paged caller may retry with a smaller `historyPageSize`; the server
does not silently re-page or retry. A smaller page can recover only when it
reduces the aligned selection enough to fit. A single source record or minimum
turn/tool-aligned group that still exceeds the cap keeps the typed failure. A
caller that does not need UI hydration may still use `resumeSession`, whose
projection kind is `none`.

## Lifecycle integration

### Cold load or resume

```mermaid
sequenceDiagram
  participant D as "Daemon route"
  participant B as "ACP bridge"
  participant A as "ACP agent"
  participant C as "Config"
  participant L as "Writer lease"
  participant R as "Transcript reader"
  participant S as "Runtime consumers"

  D->>B: "load/resume + replay options"
  B->>A: "ACP load/resume metadata"
  alt "recorder will acquire writer lease"
    A->>C: "construct Config with deferred projection"
    C->>L: "acquire authoritative writer lease"
    C->>R: "read one fresh frozen restore projection"
    R-->>C: "runtime state + optional replay page"
    C->>L: "assert owned and unchanged"
  else "recorder will not acquire writer lease"
    A->>R: "preload one fresh frozen restore projection"
    R-->>A: "runtime state + optional replay page"
    A->>C: "construct Config from ready projection"
  end
  C->>S: "complete recorder and goal initialization"
  A->>A: "build and validate bounded replay envelope"
  A->>S: "initialize Gemini; prebuild response before Session construction"
  A->>S: "run existing Session creation and rollback sequence"
  A->>S: "finalize selective restore before cron/commands"
  A-->>B: "published state + bounded replay envelope"
  B-->>D: "restored session"
```

The target construction shown above supplies the restore result consumed by the
merged #8882 transactional target-staging path. On its modern `client_identity`
path, the outer switch keeps the previous WebUI session attached until the
target is ready and commits only after a successful return and final
identity/environment/lifecycle/deadline checks. Its committed identity is the
session-id and workspace-cwd tuple, so same-id cross-workspace navigation is
still a real switch. Target-side 409, 413, timeout/504, cancellation, or staging
failure must leave that committed source tuple attached and usable; selective
restore does not own an attach or detach transition. A daemon explicitly lacking
`client_identity` keeps #8882's legacy destructive fallback and is not given a
new transaction by this slice. Transactional staging temporarily holds the
source transcript and candidate replay together in the WebUI. End-to-end memory
evidence must therefore report that WebUI overlap separately from ACP child
index/projection memory instead of adding measurements from different processes
into one ambiguous peak.

ACP `newSessionConfig()` passes an internal projection source, including the
`SelectiveSessionRestoreOptions`, through `loadCliConfig()`'s named host-options
object. It must use the startup-frozen writer-lease value, not a per-request
settings reload. With a lease, `loadCliConfig()` resolves and validates the
session id without calling `SessionService.loadSession()` and leaves the
projection deferred. Without a lease, it creates the preloaded projection before
`Config` construction. Both paths make zero calls to the old full loader.

The route remains workspace-runtime scoped. Cold projection resolution uses the
runtime-pinned cwd, runtime base directory, and per-request settings selected by
the daemon route; live projection uses the owning session's `Config`. Unknown,
untrusted, conflicting, archived, draining, or removed runtime states keep their
current declared errors and must never fall back to the primary runtime or the
agent's latest-settings cache. The session id, resolved file, first-record
project membership, and every selected record must agree before registration.

`Config.activateChatRecording()` remains the owner of lease acquisition. In the
leased mode, after acquiring the lease it requests one
`SessionRestoreProjection`, asserts that the lease and transcript are unchanged,
stores the reduced runtime state, and activates `ChatRecordingService` from the
recorder projection. Goal runtime is then restored from the normalized
`goalRecords`. This mode must skip the constructor's ordinary transcript restore
and initialize or replace the runtime only after recorder activation. When a
projection exists, it must not start from an empty or stale transcript and be
left that way.

In preloaded mode, `Config`, the legacy active recorder, and Goal runtime are
constructed directly from the already-complete reduced projection. They must
not wait for `activateChatRecording()`, because that method intentionally
returns immediately when the writer protocol is disabled.

When the frozen file contains no parseable active record, either acquisition
mode yields no projection. Preserve today's empty-resume behavior: construct the
requested Session with no resumed runtime state, let the recorder start with a
`null` parent, and return the normal empty load/resume response. A non-empty
system/metadata-only active chain is not this case; its final record UUID remains
the recorder parent exactly as it is today. Never reinterpret a project mismatch,
changed snapshot, malformed selected record, or reader limit as empty.

`Config` exposes the resolved projection through a one-shot ACP handoff. A
successful consume, initialization failure, shutdown, or `startNewSession()`
clears the pending value. Split Goal restoration behind the internal runtime
interface:

```ts
prepareRestore(
  records: readonly GoalRecoveryRecord[],
  checkpointWindow?: GoalEvidenceCheckpointWindow,
): Promise<void>;
activateRestoredWork(): Promise<void>;
```

`prepareRestore()` starts at most once and returns one memoized preparation
promise. It restores state and performs the existing legacy migration, but it
does not run a checkpoint verifier, queue a continuation, or start host work.
The selective daemon path starts preparation before Session creation without
waiting for a legacy migration to settle. `activateRestoredWork()` sets an idempotent
activation latch and returns one memoized completion that waits for preparation
before it starts any pending checkpoint or continuation. Calling activation
before preparation settles is therefore safe. `Config.getGoalRuntimeReady()`
continues to represent the complete preparation-plus-activation result, so a
first turn cannot observe an earlier readiness boundary than it does today.
Activation is valid only after preparation has started; an earlier call rejects
instead of creating a waiter that cannot yet be bound to restore input.

The existing non-daemon `restore()` remains a compatibility wrapper that awaits
preparation and activation in order. Leased mode starts preparation only after
recorder activation. If preparation rejects, activation does not start and the
existing best-effort Goal readiness failure remains observable without failing
the Session restore. Disposal prevents an unfinished preparation from committing
runtime state or broadcasting and prevents a latched activation from starting;
a legacy migration record that already reached the journal remains the one
allowed pre-response write. Disposal also rejects an activation/readiness waiter
that is waiting only for successful restore finalization, so teardown cannot leave an
unsettled Goal readiness promise. An already-running journal operation may
settle before the disposed preparation rejects, but its result cannot commit
runtime state or schedule work.

Legacy Goal recovery may append one migrated v2 `goal_state` after recorder
activation. That is an expected local post-projection write: if it completes,
it occurs only after the final snapshot/lease check, advances recorder state
normally, and invalidates the old cache key through the transcript's new
size/mtime. Session creation does not await the memoized preparation merely to
manufacture this migration; successful restore finalization schedules
activation, which waits internally for that preparation. A later failure may
race with the journal write, so cleanup
must dispose the runtime and stop any remaining work. Initial replay still
derives its bootstrap from the pre-migration normalized `goalRecords`, matching
the legacy Stop-hook state that the client needs to see.

`GeminiClient.initialize()` consumes `apiHistory`, resume token counts, and UI
telemetry events directly. It does not rebuild them from replay records. Keep UI
telemetry replay timing and its existing process-aggregate behavior unchanged;
fixing that ownership is not required for bounded hydration. Attribution is a
separate process-global singleton that a target cannot safely apply and roll back
while sibling sessions exist. Retain the projected attribution snapshot until the narrow
non-throwing selective-restore finalizer that runs after the existing fallible
Session setup and `installRewriter()`, but before the existing cron and command
startup. Any child path that still returns a restore failure therefore leaves
attribution unchanged. This guarantee intentionally does not cover a
#8691 public timeout whose underlying ACP restore later publishes successfully
and is then closed as an abandoned result: the child may briefly apply the
snapshot before late cleanup, and rolling the singleton back is unsafe while a
sibling can mutate it concurrently. Session-scoped attribution and a second
parent/child commit acknowledgement remain outside this PR, as do the existing
ownership semantics among multiple successfully published live sessions. The
same child-publication gap is broader than attribution: after the ACP child has
published but before the parent bridge/WebUI has accepted the result, Goal,
file-history validation, restored background work, cron, or command producers
may be activated. If the parent has already timed out, those producers may
briefly write or emit before #8691 recognizes the late result and closes the
abandoned child Session. #8882 preserves the old visible source on its modern
path but does not add a parent-to-child adoption acknowledgement. This is an
existing child-lifecycle residual rather than a new selective-restore
prerequisite; reopen that protocol question only if implementation evidence
shows this slice expands the window or creates work outside current teardown
ownership. Goal activation remains owned by `GoalRuntime` disposal. FileHistory
validation retains its existing service and recording-callback lifetime; this
slice does not add a detached owner or a new in-flight cancellation protocol.
The projection reader has already reduced transcript file-history records into
snapshots, but it has not hydrated `FileHistoryService`.
`Config.getFileHistoryService()` remains the single lazy owner of that runtime
state. Split its synchronous snapshot restore from
`validateRestoredSnapshots()`: after the replay envelope passes its limits,
hydrate state once in the existing `createAndStoreSession()` setup, then start
best-effort validation from the successful selective-restore finalizer.
Validation may append a replacement snapshot for a missing backup, so it must
not run on a path that can still return a restore failure. Recorder
turn boundaries already come from `runtime.recording`, and ACP turn/background
state comes from its precomputed fields, so neither may be rebuilt from a recent
replay page. The session replays only `SessionRestoreReplayPage.records` plus
the goal bootstrap described above.

For response-mode load, transform the selected records and enforce the
serialized byte/update bounds after Config authentication and tool setup but
before runtime FileHistoryService hydration or `Session` construction. The
current `createAndStoreSession()` performs `GeminiClient.initialize()` before it
constructs or inserts a `Session`, and modes/models/config options must be built
after that initialization to preserve the active-runtime model snapshot. Add one
narrow pre-construction preparation callback (or an equivalently small split in
the helper) after Gemini initialization, the second managed-admission check, and
the active-id conflict check, but before `new Session(...)` and `sessions.set()`.
It synchronously builds the complete ACP success value from the initialized
Config and already-bounded projection/envelope, including modes, models, config
options, artifact state, and replay metadata. It is not a second lifecycle gate
and is unused by `newSession`.

A size/count failure before the helper or a response-build failure in that
pre-construction slot therefore cleans up only an unregistered Config and
reservation, without hydrating file history or constructing a Session. Only
after the slot succeeds may the existing helper construct/store the Session,
hydrate file history, and copy the precomputed replay usage/turn state into it.
No fallible response builder may run after map insertion. The existing
replay-conversion partial result may still register a fully initialized runtime and report bounded
`partial`/`replayError`; it must not be confused with an envelope-limit failure.

### Existing Session creation and targeted restore finalization

Reuse #8691's existing `startingSessionIds` reservation and
`reserveStartingSessionId()` lifecycle; do not add a second `preparingSessions`
set. The reservation is acquired before cold settings/existence I/O and remains
owned through projection, pre-construction response preparation, existing
Session creation, or failure. Active and reserved ids both reject a second direct-ACP
prepare, and the current handler-level `finally` releases the reservation exactly
once. Do not add reservation-to-map conversion, a provisional unregistered
Session, or another publication protocol.

Keep `createAndStoreSession()`'s current publication and rollback structure. It
continues to create and insert the Session before its existing replay,
screen/worktree, Goal-hook, and rewriter setup. Failures already guarded by its
current `try` continue through
`discardStoredSessionIfCurrent()`/`removeStoredSessionEntry()`. Selective restore
must finish its fresh projection, replay transformation and envelope limits, and
Goal bootstrap before calling it. The helper's narrow pre-construction slot then
builds the response after Gemini initialization and before Session construction.
A failure in any of those new steps therefore has no Session entry; guarded
failures in the existing creation sequence keep their current stored-session
rollback. Do not replace either path with a map-independent teardown, move every
Session constructor callback behind a new lifecycle gate, or claim to repair
unrelated pre-existing cleanup edges.

Add one narrow ACP-only selective-restore finalizer at the end of the successful
setup sequence: invoke it after `session.installRewriter()` and before the
existing `session.startCronScheduler()` and available-command timer. The
finalizer is called exactly once, is synchronous, and does not throw. It performs
only three selective-specific actions, each behind its own error boundary:
best-effort apply process attribution, schedule
`GoalRuntime.activateRestoredWork()`, and start the idempotent FileHistory
missing-backup validation. Async completion is not awaited and cannot replace
the already-built success response. Both async calls attach rejection handlers
immediately; synchronous invocation errors and later promise rejections are
logged independently so neither becomes an unhandled rejection or skips the
other action. Existing Session constructor callbacks,
background/worktree restore, reporter notification, cron, commands, publication
timing, and rollback ownership otherwise remain unchanged.

This placement relies on the current post-rewriter tail being non-throwing:
`startCronScheduler()` contains its own asynchronous error boundary and the
available-command update is timer-scheduled/fire-and-forget. A future fallible or
awaited setup step must stay before the selective finalizer (or move the
finalizer after it); otherwise a later restore failure could occur after
process-global attribution or autonomous work had been activated.

Here child publication still means addressability in the ACP child, not
acknowledgement of #8882's WebUI commit. #8691 owns late-result fencing and
cleanup, #8833 owns attachment-identity fencing, and #8882 owns the old WebUI
attachment. The existing late-abandoned
autonomous-work window remains, but this slice adds no second client-commit
protocol and no general callback-capture framework.

### Live session load or resume

Keep `assertCanStartTurn()`, close gating, drain, and the recording write barrier.
Inside that barrier, request only the projection consumers needed for the live
operation:

- load: bounded or full visible replay plus artifact state;
- resume: artifact state only.

Use `SessionLiveRestoreProjection`; do not call the cold restore API and discard
its model, recorder, Goal, telemetry, or file-history state.

Do not reset the live model, recorder, goal runtime, or file history. A bridge
attach to an already-live entry may retain its existing in-memory replay fallback
when a best-effort transcript page cannot be read; that is not a fallback to the
old full-materialization loader.

A live direct-ACP bulk load with an explicit page also enforces the serialized
byte/update limits. Its overflow is a request-scoped ACP
`transcript_page_too_large` error, but the already-live Session remains
registered, attached to its existing clients, and usable after the close gate is
released. The daemon bridge's existing live-attach path instead catches a failed
persisted-page refresh and falls back to its in-memory replay; it must not be
changed to surface a REST 413 by this design. More generally, any live-projection
failure must leave model, recorder, Goal, file history, client accounting, and
cached restore state unchanged. Use the existing best-effort in-memory replay
fallback only where that behavior already exists; otherwise return the ACP error
without replacing or closing the live Session.

### Paths intentionally unchanged

- Interactive TUI `--resume` and `--continue`.
- Non-interactive resume.
- Session export and archived export.
- Fork, branch, and transcript copy/remap operations.
- Session list, title lookup, and preview counts.
- Legacy `qwen/session/loadUpdates`.
- Post-rewind artifact refresh.
- Live-task read/wait/startup lookup and realtime startup-context construction.

These paths continue to use complete `ResumedSessionData` until a separate
design proves that changing them is safe.

## Failure semantics

Use one restore-error mapper after cleanup at every selective boundary:
preloaded cold projection, deferred post-lease projection, cold replay
collection, and direct-ACP live projection/collection. Snapshot-unavailable
errors become ACP `-32010`; the 256 MiB transcript error becomes ACP `-32011`
with `errorKind: transcript_too_large`; byte- or update-limited recent replay
becomes ACP `-32012` with `errorKind: transcript_page_too_large`. Preserve the
diagnostic data for coalesced waiters. The existing daemon REST mapping remains
the public contract: snapshot conflict is 409 and the two size failures are 413;
no successful SDK schema is added.

| Condition                                                | Result                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcript is over 256 MiB on a cold daemon restore      | Existing `SessionTranscriptTooLargeError` becomes ACP `errorKind: transcript_too_large`, then REST `413 transcript_too_large`. The outer daemon and sibling sessions remain healthy.                                                  |
| Transcript changes after the frozen snapshot is selected | `transcript_snapshot_unavailable`/writer-change failure; no partial runtime is registered.                                                                                                                                            |
| Selected segment parses to a different UUID              | Snapshot unavailable; never skip it silently.                                                                                                                                                                                         |
| Parent is physically missing                             | Restore the surviving suffix, report the existing history gap, and disable unsafe automatic continuation as today.                                                                                                                    |
| Parent cycle is detected                                 | Stop at the cycle using the existing chain behavior and emit a diagnostic.                                                                                                                                                            |
| Compression payload is malformed                         | Preserve the current `buildApiHistoryFromConversation()` behavior: falsey/missing `compressedHistory` does not replace an earlier candidate, while a truthy malformed selected payload fails restore through the existing error path. |
| File-history or artifact item is malformed               | Preserve the current warning-and-skip reducer behavior.                                                                                                                                                                               |
| Cold transformed recent replay exceeds byte/update cap   | Fail before registration and release Config/lease. Return ACP `errorKind: transcript_page_too_large`; the daemon REST path maps it to `413 transcript_page_too_large`.                                                                |
| Direct-ACP live transformed replay exceeds the cap       | Return ACP `errorKind: transcript_page_too_large` without mutating or closing the registered Session. The daemon bridge's existing live attach instead keeps its in-memory replay fallback.                                           |
| Live projection or selected read fails                   | Release the close gate and preserve the existing registered Session and client accounting. Use only an already-supported in-memory replay fallback; otherwise return the mapped request error.                                        |
| Client omits `historyPageSize`                           | Full visible replay, no default truncation.                                                                                                                                                                                           |
| Recorder will not acquire the writer lease               | Use one fresh preloaded frozen projection and preserve the current unfenced consistency contract; never use the old loader.                                                                                                           |

There is no selective-to-full-loader fallback on a cold restore. A fallback
would recreate the timeout and peak-memory failure mode precisely when the
selective path rejects the largest input.

## Downstream consumer migration

Every current consumer of full `ResumedSessionData` inside the ACP
`session/load` and `session/resume` pipeline must have an explicit replacement:

| Consumer                          | Current dependency                                                       | Replacement                                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `loadCliConfig()`                 | First full load                                                          | Preload one projection only when the writer protocol is disabled                                                              |
| `Config.activateChatRecording()`  | Optional second full authoritative load                                  | Resolve the deferred projection under the acquired lease                                                                      |
| `ChatRecordingService.activate()` | Last UUID, turn parents, title and lineage from all messages             | `runtime.recording`                                                                                                           |
| `Config.initializeGoalRuntime()`  | Full message list                                                        | normalized `runtime.goalRecords`                                                                                              |
| Goal pending-checkpoint recovery  | `readActiveTranscriptChain()` full reload                                | projected bounded Goal checkpoint window                                                                                      |
| `GeminiClient.initialize()`       | API history, telemetry, token counts, attribution from full conversation | Pre-reduced runtime fields; attribution applied by the finalizer                                                              |
| `Config.getFileHistoryService()`  | Lazy restore from `sessionData.fileHistorySnapshots`                     | Synchronous restore once after envelope validation                                                                            |
| `createAndStoreSession()`         | Gemini initialization, file snapshots, turn boundaries, replay records   | Prebuild the response in a narrow post-Gemini/pre-construction slot; reuse existing creation/rollback and finalization timing |
| `Session.primeTurnFromHistory()`  | Initial turn and background notification ids                             | Precomputed ACP state                                                                                                         |
| daemon goal hook restore          | Slash-command cards from all messages                                    | normalized `runtime.goalRecords` through the existing helpers                                                                 |
| load response artifact state      | Rebuilt from all physical records                                        | `runtime.artifactSnapshot`                                                                                                    |
| live load/resume                  | Full reload under write barrier                                          | Consumer-limited live projection under the same barrier                                                                       |

The implementation is incomplete if any `session/load` or `session/resume`
consumer named above still calls the old loader or silently treats a recent
replay page as a complete conversation. It is also incomplete if a daemon-owned
caller that ignores replay still requests compatibility-mode `all`. The
explicitly unchanged public and legacy paths remain outside that assertion.

## Observability

Build on #8691's `qwen-code.daemon.session_restore` span. Add child-stage
durations or nested spans for:

- `transcript_index`;
- `resume_state_select`;
- `selected_record_read`;
- `history_replay`;
- `runtime_initialize`;
- `post_replay_services`.

Record only bounded numeric, enum, and boolean attributes: snapshot bytes,
indexed/active/selected/replay counts and bytes, compression selected, legacy
full-model-history fallback, cache hit, partial replay, projection acquisition
(`preloaded` or `after_writer_lease`), replay mode (`none`, `recent`, or `all`),
and envelope limit reason (`bytes` or `updates`). Do not record transcript
content, prompts, tool arguments, record ids, paths, or cursor values.

The parent daemon span should continue to own action, timeout, public outcome,
late outcome, cleanup, and channel lifecycle from #8691.

## Validation strategy

### Projection equivalence

For deterministic well-formed fixtures, compare the new projection against the
current full loader plus its existing reducers:

- compressed and uncompressed model histories;
- multiple compression records, including dead-branch records;
- rewind branches, forks, inherited history, and side-task source boundaries;
- fragments and glued JSON records;
- partial final lines, missing parents, and cycles;
- UI telemetry, token counts, and attribution snapshots;
- v2 and legacy goals, including malformed terminal records;
- pending Goal checkpoints, including parity of the bounded evidence window;
- duplicate file-history prompt ids and the 100-snapshot cap;
- artifact snapshots/events on active, side, and abandoned branches;
- custom titles, parent/source metadata, initial turn, and background task ids;
- empty or all-unparseable files produce no projection and no manufactured
  recorder parent, while a non-empty system/metadata-only active chain preserves
  its final record UUID.

Title parity must use the bounded tail-then-head production picker, including a
legacy title outside both windows that intentionally remains invisible. File
history tests must assert that lazy service construction restores the selected
snapshots once rather than relying on duplicate idempotent calls.

The expected value must come from the existing production reducers, not a
second hand-written expectation that can reproduce the same mistake. Malformed
compression fixtures must assert the current candidate-selection and failure
behavior rather than inventing a new fallback.

### Paging and limits

- Recent replay respects record and source-byte budgets while preserving turn
  and tool-call/result boundaries within the existing bounded extensions.
- Omitted `historyPageSize` returns the full visible replay.
- Runtime history remains complete when UI replay is paged or hides inherited
  records.
- An individually oversized record and collective ACP-update expansion both
  fail with ACP `transcript_page_too_large`; the cold daemon path maps it to REST
  413 before session registration, while a direct-ACP live case preserves the
  existing Session and the daemon bridge live attach preserves its fallback.
- Exact envelope fixtures accept 32 MiB and 10,000 updates and reject the first
  extra byte and the 10,001st update, including UTF-8 escaping and every
  optional/bootstrap/synthetic/finalization field in the serialized value.
- Typed byte/update-limit failures bypass the ordinary replay
  `partial`/`replayError` compatibility path; unrelated replay conversion
  failures retain that existing partial-result behavior.
- A legacy-Goal migration followed by replay overflow leaves only the expected
  migrated v2 record on disk; it does not append replay data, register a Session,
  or reuse the now-stale projection cache entry.
- A still-active v2 or legacy goal older than the recent page is represented by
  one bootstrap update; terminal or in-page goals are not duplicated.
- Mixed v2/legacy goal sequences produce the same final bootstrap state as full
  history replay.
- A newer malformed v2 record still permits recovery of the newest earlier valid
  v2 snapshot, while malformed/unsupported v2 records with no valid v2 block
  legacy fallback exactly as `recoverGoalFromRecords()` does today.
- A malformed file-history batch contributes no snapshots, matching the current
  whole-record skip behavior.
- Hint-heavy index fixtures account for all newly retained metadata and overhead
  in the shared estimator. An index whose own estimate exceeds the entire cache
  budget may serve requests sharing its in-flight build, but its completed value
  is not cached. That completed-value byte-budget admission does not evict an
  already-cached value; pending coalescing and entry-count or aggregate LRU
  behavior remain unchanged.
- A fresh cold index is offered only after selected reads and final snapshot or
  lease validation. Concurrent cold projection and cached paging of the same key
  do not clobber a pending/completed entry; stale pending resolve/reject handlers
  cannot overwrite or delete a newer value; failed selected reads leave no
  completed cache entry.
- One cold projection performs exactly one sequential full transcript index scan
  plus bounded selected-record seeks and the existing bounded title windows. It
  never calls public paging/cache lookup internally, never performs a second
  scan for recent replay, Goal bootstrap, or pending-checkpoint evidence, holds
  at most one in-progress aggregate record plus the fixed glued-line cache and
  declared final outputs, and validates selected I/O counts against the
  deduplicated UUID/segment plan.
- The full scanner and transcript-proportional selected dispatcher yield to the
  event loop after a fixed source-byte or elapsed-processing budget, only at
  complete physical-line or aggregate boundaries. Deterministic scheduling tests
  prove a queued timer/sibling callback runs before a large scan completes,
  without changing record order, scan count, or reducer output. A single large
  JSON record remains the documented indivisible scheduling unit.
- A sparse transcript over 256 MiB fails before parsing and never invokes the
  old loader.
- Concurrent append/growth, snapshot replacement, truncation, same-size rewrites
  that change mtime, selected-segment UUID mismatches, and selected records with
  a conflicting session id are rejected. A lease-off adversarial rewrite that
  preserves inode, size, mtime, and selected UUIDs remains outside the legacy
  unfenced guarantee.

### ACP and daemon lifecycle

- Cold load and resume build exactly one fresh transcript index in both
  writer-lease modes and make zero calls to `SessionService.loadSession()` on
  the selective path. Live `session/load` and `session/resume` also avoid the
  old loader.
- The projection is created only after writer-lease acquisition and is checked
  again before activation when chat recording and the writer protocol are both
  enabled; otherwise it is preloaded before `Config` construction and never
  waits on the no-op activation method.
- A recorder-disabled fixture with the startup-frozen writer setting enabled
  still uses `preloaded`, performs no lease acquisition, and initializes the
  remaining model/ACP consumers from the projection.
- Load, resume, live restore, coalesced restore, `loadUpdates`, and cleanup keep
  their current ownership and write-barrier semantics.
- Same-shape bridge requests coalesce, while omitted/full versus explicit recent
  replay and unequal explicit page sizes return `restore_in_progress`; a waiter
  never receives another request's replay shape or loses typed error data.
- Bridge ingress rejects an invalid meaningful page size before warm/cold
  lookup, capacity admission, or coalescing. Streamed load and resume ignore the
  otherwise unused field consistently in both residency states.
- Session-id reservation covers scan through the existing creation attempt.
  Concurrent direct-ACP restores of one id cannot both prepare, and every
  failure releases the reservation for a clean retry.
- New failures before `createAndStoreSession()` and in its post-Gemini,
  pre-construction response slot leave no map entry. Failures in its currently
  guarded setup sequence use the stored-session rollback and leave no stale Goal
  hook/observer, MCP ownership, Config, or map entry.
- Envelope overflow and a new pre-construction response-preparation failure do
  not hydrate or validate the runtime FileHistoryService and cannot append a
  missing-backup snapshot.
  Successful creation restores state once and starts validation once from the
  narrow finalizer.
- Pending Goal checkpoints use only the projected bounded evidence window: the
  restore path neither invokes the old full loader nor starts verification or
  continuation before successful restore finalization. Active-chain evidence
  hints first select the same bounded catalog UUIDs as the production helper;
  only those records are materialized into the shared accumulator, with no
  all-record selection or second scan.
- Goal preparation and activation are each memoized. Activation may be requested
  before preparation settles, `getGoalRuntimeReady()` waits for both phases, and
  non-daemon `restore()` retains its existing awaited behavior. Activation before
  preparation starts rejects, while disposal settles any waiter that would
  otherwise remain blocked waiting for successful restore finalization.
- Every child path that returns a restore failure leaves process-global
  attribution unchanged. The narrow non-throwing finalizer applies the snapshot
  once after all existing fallible setup and before cron/commands. A later #8691
  abandoned-result cleanup is not claimed as rollback-safe for either the
  singleton or autonomous work activated between child publication and parent
  adoption; this existing residual is documented without adding a new protocol
  prerequisite unless implementation evidence shows the slice expands it.
- The complete ACP success response is built after Gemini initialization but
  before runtime FileHistoryService hydration, Session construction, or map
  insertion. A response-builder failure performs none of the latter three and
  leaves no map entry.
- Scheduled-task rehydration/keepalive and channel restoration use resume/none
  rather than compatibility-mode all replay. They restore runtime services and
  receive their required later live updates without collecting historical
  replay frames.
- The selective finalizer runs once after rewriter installation and before cron
  and command startup. Attribution, Goal activation, and FileHistory validation
  synchronous failures and asynchronous rejections are independently contained
  and cannot convert the prebuilt success into a restore failure or become
  unhandled rejections. Existing Session callback timing is unchanged.
- ACP `errorKind: transcript_too_large` is request-scoped, REST maps it to
  `413 transcript_too_large`, and a registered sibling remains usable.
- Cold projection and cold envelope-limit failures do not register new runtime
  state. Existing replay-conversion partial results register only after the
  runtime is otherwise fully initialized.
- Live projection and envelope-limit failures release the close gate without
  changing the registered Session, its model/runtime services, or attach/client
  accounting.
- A timed-out selective projection follows #8691's abandoned-restore fence,
  same-id retry, late cleanup, settlement-grace, and condemned-channel drain
  semantics. In particular, an overdue child that cannot answer a close probe
  must still be locally torn down after its clients detach. Newly activated Goal
  work is suppressed by Goal disposal; FileHistory validation retains its
  existing service/callback cleanup semantics and does not gain a detached owner.
- #8691 timeout and late-result fencing tests continue to pass.
- #8882 integration tests prove that, on the modern `client_identity` path,
  selective-restore 409, 413, timeout/504, cancellation, and staging failures
  preserve the committed session-id and workspace-cwd source tuple and that
  successful adoption changes transcript, connection, metadata, and ownership
  atomically. Its explicitly unsupported-capability fallback retains the legacy
  detach-first behavior.
- #8933 coordinator tests prove that identical target/mode/page shapes coalesce,
  while `load` versus `resume` and unequal effective page sizes serialize as
  distinct intents and never reuse another request's replay result.

### E2E and benchmark

Before implementation, dry-run the scenario with the installed global `qwen`
CLI and retain the baseline result in `.qwen/e2e-tests/`.

Compare the current full loader and selective projection under the same runtime
with 64 KiB, 1 MiB, and 4 MiB fixtures. Report absolute wall time plus peak and
settled memory. These measurements are evidence, not a latency gate. If they
show a meaningful absolute regression, keep any small-file optimization inside
the selective scanner and reducer rather than routing production back to the old
loader.

Use an opt-in approximately 80 MiB/30,000-record fixture containing an
approximately 2 MiB record and at least one live sibling session. Report:

- cold restore wall time;
- peak and post-registration settled heap/RSS or cgroup memory when available;
- event-loop lag during the scan;
- the largest observed physical-record parse/validation interval;
- index bytes, selected record bytes, and replay bytes;
- whether compression or the legacy full-model-history fallback was used;
- sibling prompt continuity during and after restore.

The benchmark is evidence, not a CI latency assertion. Functional CI asserts
the number of scans, selected bytes, bounded replay, failure shape, cooperative
scheduler progress, and sibling survival.

## Alternatives considered

### Increase the timeout only

#8691 makes the timeout safe and configurable, but a longer deadline does not
remove duplicate reads or full materialization. It is necessary safety work,
not the performance design.

### Page only after `SessionService.loadSession()`

This is the current shape. It reduces response count while retaining the same
parse, allocation, and reconstruction cost, so it does not address the cold-load
hot path.

### Split duplicate-load removal and early paging from the projection

The second load exists only when chat recording is enabled and the recorder
actually acquires the startup-frozen, default-off writer lease. It is the
authoritative post-lease snapshot; reusing the pre-lease result would weaken
fencing. Applying `historyPageSize` before full materialization also requires the
runtime projection because model, recorder, Goal, file-history, artifact,
telemetry, and ACP state still need complete semantics. Reviewable commits may
follow the implementation phases, but an independently merged partial PR would
either leave the default incident path unchanged or introduce an unused
projection boundary.

### Default every client to a recent page

That would be simpler internally but would silently change old ACP client
semantics. The selected compatibility contract is explicit opt-in pagination;
omission still means full visible replay.

### Require or implicitly enable the session-writer lease

The writer protocol is experimental, restart-gated, disabled by default, and
unsafe when concurrent writers mix configurations. Requiring it would leave the
default daemon path unfixed; enabling it inside this PR would silently broaden
scope into writer-protocol rollout. The selected design changes only projection
acquisition: the lease-on path is authoritative, while the lease-off path keeps
today's consistency guarantee and still removes full materialization.

### Change `ResumedSessionData.conversation.messages` to be lazy or partial

Too many consumers assume it is complete. Making completeness implicit would
invite model truncation, broken rewind boundaries, and lost restore state.
A separate projection makes every migration explicit.

### Defer file-history restoration until `/rewind` or a file operation

The first resumed turn can create a snapshot that must inherit restored tracked
files and backups, so those triggers are too late. `Config.getFileHistoryService()`
is synchronous, and retaining projection data or reopening the transcript for
later asynchronous restoration would broaden ownership and failure semantics.
This slice therefore reduces file-history records during projection and forces
one synchronous service-state initialization during the existing Session setup
and before projection release. Only the existing best-effort backup validation
is deferred to the successful non-throwing finalizer so it cannot write for a
failed target; making the service's required restore state asynchronous would
require a separate design.

### Add the durable checkpoint in the same PR

Checkpoint validation, a new atomic publication protocol, crash recovery, transcript
replacement, rewind invalidation, and legacy bootstrap are a separate failure
domain. Combining them would make the first performance PR harder to review and
roll back. The streaming selective scan is also the required fallback for a
missing or invalid future checkpoint.

The checkpoint design must independently define a versioned discard-and-rebuild
schema, atomic publication bound to a validated transcript prefix, an index
coverage/active-leaf/tail-parent invariant, and bounded write amplification.
Whether and how it persists the UUID-to-offset index and encodes incremental
updates remains a decision for that phase. Existing file identity and snapshot
size are a useful minimum but do not close same-inode in-place rewrite races
without the cooperative writer protocol. Its legacy, corrupt, and missing
checkpoint fallback reuses the cooperative full-scan policy above.

### Fall back to full materialization when indexing rejects a large file

This makes the worst input take the least safe path and defeats the cap. The
selected behavior is ACP `errorKind: transcript_too_large`, mapped by REST to
request-scoped `413 transcript_too_large`.

### Use the old full loader for small transcripts

Indexing plus selected reads may have a relative overhead on small inputs, but a
production fallback would retain two reducer, error, and lease-semantics engines.
Benchmark small fixtures first. If the absolute regression is meaningful,
optimize the selective scanner to reuse records from its current scan without
putting payloads in the index cache; do not route production through
`SessionService.loadSession()`.

### Make the transformed-replay cap configurable or trim updates

The 32 MiB cap is a fixed transformed-envelope policy for explicitly recent bulk
replay, preventing that source-bounded mode from expanding without a response
memory bound. It is not a global child-pipe limit: legacy unpaged replay remains
the compatibility exception described above. Raising or configuring the recent
limit defeats its bound and makes behavior depend on runtime settings. There is
also no reliable class of non-critical ACP updates: dropping updates can
separate tool calls from results, change goal or turn state, or make replay
metadata disagree with its contents. The selected behavior is a typed failure
plus an explicit smaller-page retry when the aligned selection can be reduced.

## Risks and mitigations

- **Semantic drift between runtime and replay chains.** Keep two named UUID
  sequences and parity-test them against current reducers.
- **Two writer-consistency modes diverge.** Share the projection and every
  reducer; vary only whether acquisition occurs before `Config` construction or
  after lease ownership. Test both modes with the startup-frozen setting.
- **Lease-off identity checks cannot prove an adversarial file was unchanged.**
  Recheck inode, size, and mtime and validate selected UUIDs, but state the
  residual same-identity/same-mtime rewrite race explicitly; only the cooperative
  writer protocol closes it.
- **A hidden full-history consumer is missed.** The consumer migration table is
  a completion checklist; repository-wide read-site audits are required for any
  changed field or getter.
- **Index metadata grows too much.** Reuse the existing cache estimator and cap;
  account for all newly retained metadata plus container, key, value, and
  base-object overhead.
- **Reduced payloads become a second lifetime session copy.** Treat the
  projection as one-shot state, force lazy consumers before release, and assert
  that success, failure, and `startNewSession()` clear all pending payload
  references.
- **Goal recovery silently re-enters the old loader or starts hidden work.**
  Project the bounded pending-checkpoint evidence window during the one scan,
  memoize state preparation and activation separately, let activation wait for
  preparation, and arm the verifier/continuation only from successful restore
  finalization.
- **Failed-target attribution corrupts a sibling through the global singleton.**
  Retain the snapshot in the one-shot projection and apply it only in the narrow
  non-throwing finalizer after existing fallible Session setup; guarantee failed
  child restores leave it unchanged and
  document that a #8691 late-abandoned success cannot be rolled back safely.
- **A late-abandoned child starts hidden autonomous work.** Child publication is
  not parent adoption. Document that Goal, file-history, background, cron, or
  command work may briefly run until #8691 late cleanup. Keep Goal activation
  under existing runtime disposal and FileHistory validation under its existing
  service/callback lifetime; do not add a detached owner. Reopen a parent/child
  adoption protocol only if implementation evidence shows this slice widens the
  existing residual.
- **The Session publishes before its response is known to be buildable.** Build
  the complete ACP success value before FileHistory hydration and Session
  construction, then make every later activation best-effort.
- **Selective finalization failure changes a successful restore.** Keep the
  finalizer non-throwing and isolate attribution, Goal activation, and
  FileHistory validation so one failure does not skip the other two or replace
  the prebuilt response.
- **Selected reads are accumulated before reduction.** Use a consumer dispatcher
  with per-record fragment assembly; stream file-history and artifact inputs into
  their existing semantics and retain only unavoidable projection outputs.
- **A full scan starves live siblings on the shared child.** Yield after a fixed
  source-byte or elapsed-processing budget at complete physical-line boundaries,
  and use the same policy for transcript-proportional selected dispatch. Keep a
  single large record as an explicit residual instead of adding worker-thread or
  streaming-parser scope.
- **No-compression sessions still materialize substantial model history.** Emit
  a diagnostic attribute and state the limitation; the checkpoint follow-up is
  the only safe way to make these restores tail-proportional.
- **Replay transformations expand beyond source bytes.** Enforce byte and update
  caps incrementally before transport and session registration; return the
  existing structured page-too-large failure instead of adding a second paging
  reducer over transformed updates. Document the new 32 MiB failure boundary as
  an intentional explicit-page compatibility change and require maintainer
  sign-off.
- **Lease integration introduces a new race.** The lease remains owned by
  `Config`; projection creation and the final unchanged assertion occur within
  the same activation transaction.
- **PR scope becomes a core refactor.** Reuse `SessionTranscriptReader`, existing
  reducers, error classes, and wire fields. Do not generalize TUI or export
  loading in this PR. Before implementation, report the production-logic line
  count and cross-package/core ownership to maintainers. Keep the delivery
  classified as the requested feature; if the work instead becomes a 500+
  production-line core `refactor`, the repository's maintainer-only gate applies
  and the change must not proceed as an external refactor PR.
- **The 256 MiB limit rejects a transcript the old loader attempted.** Keep the
  error request-scoped and observable, document it in the PR as an intentional
  daemon-only compatibility change, and require maintainer sign-off rather than
  hiding it behind a full-loader fallback.

## Rollout and follow-ups

#8691, #8833, #8882, and #8933 are merged. Start selective development from
fresh `main` containing the completed request-shape fix, followed by the durable
checkpoint. #8883 and the later PR3c/PR3d ownership slices are not prerequisites
for this bounded hydration path. Keep selective restore as one end-to-end
implementation PR, using reviewable commits for the phases below; do not land an
unused projection API or a partial early-paging step.
`historyPageSize` cannot bound pre-materialization I/O without the consumer
projection, and the writer-lease path's post-acquisition read remains
authoritative.

After selective restore:

1. Add the durable checkpoint sidecar so valid restores read the checkpoint and
   only the JSONL tail, using this selective scanner as the legacy/corrupt
   fallback with the same cooperative-yield policy. Its design owns the exact
   versioned schema, transcript-prefix validation, persisted-index format,
   active-leaf/tail-parent invariant, and bounded incremental publication.
2. Migrate standalone `qwen/session/loadUpdates` and post-rewind artifact refresh
   only if their independent compatibility and failure semantics justify it.
3. Consider extending selective loading to TUI resume only after the daemon path
   has equivalence and operational evidence.
