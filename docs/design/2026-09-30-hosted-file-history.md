# Hosted Workspace file history

[English](2026-09-30-hosted-file-history.md) | [简体中文](2026-09-30-hosted-file-history.zh-CN.md)

Status: implemented behind the private gates. Tracks #13105, following #12831.

## Problem and scope

Before this change, Hosted Write/Edit retained tool messages but disabled file
backups. The existing ManagedToolFileHistory and FileHistoryService provide prompt
snapshots and restoration. Hosted reuses these on the worker, retaining
the raw executor and its original invocation journal, including Shell v3.
Migrating execution to the provider protocol would unnecessarily change Shell
publication and recovery.

This adds private file-history inspection and file-only undo, not conversation
rewind or public UI. Shell mutations are not backed up. Restoring requires the
same Workspace filesystem and persistent worker backup volume; this does not
provide cross-host backup transfer or recovery of unknown executions.

This slice supports the files and Shell profiles. The MCP profile keeps its
existing behavior, including native Write/Edit, and refuses the file-history
APIs. Its long-lived runtime and active connections need a separate history
lifecycle design; this change does not claim backups for that profile.

The model-facing native Write/Edit declarations explicitly disclose the MCP
profile's lack of file backups and undo. Files/Shell declarations explain that
tracked content or mode drift within the same prompt refuses further Write/Edit
and undo; Shell mutations themselves are not backed up. Starting a new prompt
can capture a fresh preimage only after complete backup validation. Undoing an
older prompt restores its historical preimage across later rebaselines, including
external or other-Session edits retained in newer snapshots.

## Execution and persistence

The existing Broker control route gains a `raw-file-history` operation. It
routes directly to raw history without acquiring a provider session. Its
`bind`, `prepare`, `snapshot` and `rewind` actions belong to the acquired
live Session's selected Workspace. Worker activation, resolved directory,
Harness Session identity and runtime Session identity are checked. No action
falls back to the Harness directory or another runtime.

Bind restores the latest complete history state from the Session Store and
uses the stable Harness Session ID as backup owner. Prepare creates one
snapshot per prompt and backs up each admitted Write/Edit path before dispatch.
The existing best-effort backup API is followed by explicit verification that
each required backup exists and is not marked failed. The Harness commits
this state to the existing `file_history` domain before starting file effects.
Each commit also carries the existing `file_history_snapshot` reader record,
so transcript projection continues to understand the domain.
Denied calls do not create backups. Repeated edits retain the prompt's original
preimage.
Within a prompt, preparation refuses changes to a tracked path since the last
tool effect. A new prompt is the rebaseline boundary: prepare samples all tracked
files, creates and validates a new snapshot, then verifies the samples again
before accepting the new expected state. This retains external/Shell bytes and
modes in that prompt's preimage without changing older snapshots. Same-prompt
retries and undo still refuse drift. Other writers must be quiescent during
preparation; a failed backup or changed sample cannot refresh expected state.
A refused preparation restores the last successful snapshots and prompt bookkeeping,
retaining the expected file state and allowing a narrower retry of the same prompt.
A definite
preparation refusal becomes a persisted tool error for the batch's Write/Edit
calls; other admitted calls may continue. A definite bind refusal in a new turn
ends it with an error after confirmed runtime release. Neither case blocks the Session
or retains idle Workspace ownership. Missing backups can be restored and retried;
unknown responses and failed release still require recovery. Binding a saved
Shell continuation is different: refusal preserves its original runtime and
recovery state, because closing that runtime would strand the unfinished turn.
Refusal inside native execution before entering the tool action also settles as
a tool error. History failure after entering the action remains unknown, including
the immediate execution response and retries of the same invocation.

After every completed batch, including tool errors and cancellation, the
worker records current byte digests and modes for affected files. The Harness
persists the resulting state before model continuation and runtime release.
A definite execution-reservation conflict becomes a durable tool refusal and
creates no runtime binding; other admitted calls still settle normally. A batch
with no reservations skips the runtime wait checkpoint and clears its prepared
history after recording the refusals.
Unknown execution or failed history persistence blocks the Session. On detach
and load, a pending turn may resume only when its matching durable checkpoint
contains nonempty, fully settled tool results. A durable `pendingMessageId` binds
this evidence to the current batch's assistant message, not a previous batch.
The Harness acquires the original
runtime and reads its already-bound history without rebinding the pre-effect
state. It checks snapshot identity, persists settlement, and resumes from the
saved results without dispatching the tools again. A missing original runtime,
unknown execution, incomplete results, changed snapshots, pending undo or failed
observation/persistence remains blocked. No timeout or finally block clears the
marker. This also handles interruption after history settlement but before model
continuation. Retrying observation does not dispatch another mutation. Content equality avoids
duplicate history commits; worker-local revision counters are not durable IDs.

Snapshots and expected file states are stored in the Session Store. Backup
bytes remain in FileHistoryService's worker storage. Missing backups and
invalid/outside/symlink paths fail closed. Backups are revalidated before
mutation, settlement and undo, including during a live worker's lifetime.
Transient backup access errors reject the operation without marking the backup
permanently failed. Tracking maps preserve legal prototype-named files across
serialization and cold binding. Verified Workspace reload validates file-history
records and their previous-record resources as well as the latest state.
Retention is bounded to 100 prompt snapshots; reaching the bound refuses another
mutating prompt rather than deleting backups still referenced by durable history.
The existing 64 KiB inline Store limit also applies to each history record.
Before Write/Edit and undo, preflight includes both snapshot copies, retained
receipts, the pending marker, maximum post-effect fingerprints and (for undo)
a receipt listing every tracked file. Reserve 1 KiB for the authority envelope.
Capacity refusal happens before native effects and leaves the Session usable;
undo returns `409 hosted_file_history_capacity_exceeded` before acquiring a
runtime. Read/Shell calls remain available, but further Write/Edit may require
a new Session. Repeated undo can exhaust the same budget; completed receipt
replay remains available. There is no pruning or unbounded retention guarantee.
Actual persistence failures continue to retain pending recovery markers.

## File-only undo

The private Hosted API adds `GET /session/:id/files/history` and
`POST /session/:id/files/rewind` with a target `promptId` and UUID `requestId`.
Both are live-session-owner scoped and require the existing client identity;
undo additionally requires an idle, writable, unblocked file-tool Session.
Closing, busy or recovering owners refuse undo before acquiring a runtime.
The request uses its own acquired runtime Session and restores the saved state.
Workspace busy/unavailable returns a retryable 409. A definite bind refusal
releases the acquired runtime and returns `409 hosted_file_history_refused`
before writing pending state. That released request ID cannot be acquired again:
retrying it returns `409 runtime_session_not_acquirable` without blocking. After
repair, submit a new request ID. Busy/capacity refusals can reuse the same ID;
completed receipts are always replayed by the original ID. Unknown
acquisition/bind/release outcomes block.

Rewind restores the state at the start of the target prompt, including changes
from later prompts. Snapshots remain available, so choosing a later target after
an earlier rewind can move files forward again. Newly created directories remain.

Before undo effects, persist a pending undo record. Compare every tracked file
against its last observed digest and mode; a subsequent external or Shell
change is a conflict. Reuse `rewind(promptId, false)` to restore existing files
and remove newly created files without deleting backup evidence. Persist the
resulting expected file states before release and completion. A partial restore,
unknown response or persistence failure remains blocked, including after reload.
This is not an atomic multi-file transaction: other writers must be quiescent
throughout undo; a conflict detected before restoration changes no files.
Path-type changes and fingerprint read failures during the read-only preflight
also return conflict without changing expected state. Backup validation failures
and errors after restoration starts retain their existing failure semantics.
Completed undo receipts remain in subsequent history records, so retrying an
older request after another undo, Write/Edit or reload returns its original
result without reacquiring a released runtime. Receipts share the same bounded
inline record budget as snapshots.

### Stored receipt validation (#13124)

On every read, validate each stored receipt before callers can use it for history
inspection, capacity calculation, history binding during tool acquisition, load
or undo replay. Each receipt
has exactly `requestId`, `promptId`, `filesChanged` and `conflict`: both IDs use
the undo API's UUID syntax; the prompt must belong to a retained snapshot;
request IDs are unique across the cumulative receipt list. Changed paths are
unique canonical tracked paths, including legal prototype-named files. A
conflict receipt has no changed paths. Missing `undoReceipts` means an empty list
for older records; null, malformed entries and unsupported fields are refused.
An invalid record follows the existing read/recovery error paths before effects.
The provider boundary also refuses rewind outcomes with duplicate or untracked
changed paths, a missing requested snapshot, or changed paths on conflict before
a receipt can be persisted. Unknown effects keep the readable pending record and
existing recovery boundary. Receipt errors identify the index and failed rule;
load and history-read failures log the cause server-side without changing client
error codes or exposing validation details.

Receipts are immutable historical outcomes, not a description of current file
contents. Later undo and Write/Edit commits preserve them in order, and replay
returns the original result without acquiring or dispatching another runtime.
Do not compare an old receipt with the latest prompt or current fingerprints.
A post-effect record may contain both the matching receipt and `pendingUndo`
until release is confirmed; the pending marker still prevents replay and load.
If that pending request already has a receipt, their prompt IDs must agree.

Hosted snapshots and tracked paths currently never shrink: prepare refuses a new
prompt at 100 snapshots, and rewind passes `truncateHistory = false`. Future
retention or pruning must remove receipts referencing evicted prompts or paths
in the same durable commit, preserving replay for all retained receipts.

This follow-up changes validation and disclosure only. Retention, pruning,
same-prompt reconciliation, cancellation during undo, I/O optimization and
operator recovery for unknown/partial effects remain separate work. No backup
is deleted and no lease timeout authorizes another writer.

## Deployment and rollout

Worker backups live under `$QWEN_HOME/file-history/<Harness Session ID>/`
(or the worker OS user's `~/.qwen/file-history/`). Set an absolute `QWEN_HOME`
on the Broker's worker environment and mount durable storage writable by the
worker user. Preserve it alongside the Workspace and SQL store; persisting only
the Workspace or database does not retain backup bytes. Keep referenced backup
files across restarts. A missing backup is a definite refusal until repaired;
unknown or partial effects still require operator recovery.

Upgrade the Broker and worker bundle before the Hosted Harness. Older Brokers
reject raw-history control with `400 runtime_control_operation_invalid`; the
Harness releases that failed bind and ends the turn without dispatching tools.
It does not fall back to unbacked writes. Matching server/worker versions are
required to resume files/Shell tool turns.

## Implementation boundaries

- CLI: history state validation/worker adapter, raw executor binding, existing
  provider-control dispatch, Hosted Broker client, tool-turn settlement and
  private Session routes.
- Java Broker: admit and forward the bounded raw-history control operation
  without provider acquisition; keep existing ownership and control exclusion.
- Core: reuse existing file-history services without changing legacy CLI's
  best-effort backup policy. Compare backup contents as bytes; decoded UTF-8
  equality and older modification times do not prove that files are unchanged.
  This shared comparison serves snapshot inheritance and restoration.

## Validation and acceptance

Use focused tests for parsing, backup failure, same-prompt idempotence,
multi-batch writes, post-error/cancel history, restoration, conflict refusal,
missing backups, owner/path isolation and pending undo after reload. Exercise
two Workspaces through the packaged Hosted CLI, real worker, Java Broker and
HTTP Session Store. Verify existing file restoration and new file removal,
plus default no-tool and Shell regressions. Build, typecheck, bundle, focused
tests and two clean self-audit passes are required. E2E plans and measured
results live in `.qwen/e2e-tests/hosted-file-history.md`.

For #13124, add malformed-receipt and profile-disclosure assertions, and strengthen
existing HTTP undo tests for mismatched replay keys, conflict replay and durable
pending state. Reuse the existing later-undo, Write/Edit and reload replay tests.
Verify fresh-turn pending-history guards and capacity refusal before dispatch.
The focused plan and measured results are in
`.qwen/e2e-tests/issue-13124.md`; the real Java/MySQL fault gates remain required
for changes to their execution behavior.

Local validation passed: build, typecheck, bundle, focused tests, packaged worker
fault probes and Hosted process regressions. The Broker/HTTP Store E2E used H2
in MySQL compatibility mode; it verifies detach/load and actual file restoration,
not production MySQL or database process restart.

## Risks and open questions

Backup availability depends on the persistent worker volume. Unknown mutation
and partial undo require operator recovery; automatic recovery is outside this
change. Public UI, backup garbage collection beyond the retained window and
cross-host backup transfer remain separate work. There are no open API choices
for this slice.
