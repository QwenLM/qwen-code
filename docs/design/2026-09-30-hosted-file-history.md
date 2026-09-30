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
Preparation also refuses changes to a tracked path since the last tool effect;
another Write/Edit cannot silently absorb an external or Shell edit.

After every completed batch, including tool errors and cancellation, the
worker records current byte digests and modes for affected files. The Harness
persists the resulting state before model continuation and runtime release.
Unknown execution or failed history persistence blocks the Session. Retrying
observation does not dispatch another mutation. Content equality avoids
duplicate history commits; worker-local revision counters are not durable IDs.

Snapshots and expected file states are stored in the Session Store. Backup
bytes remain in FileHistoryService's worker storage. Missing backups and
invalid/outside/symlink paths fail closed. Backups are revalidated before
mutation, settlement and undo, including during a live worker's lifetime.
Retention is bounded to 100 prompt snapshots; reaching the bound refuses another
mutating prompt rather than deleting backups still referenced by durable history.
The existing 64 KiB inline Store limit also applies to each history record;
an oversized preparation is refused before dispatch, and a settlement that
cannot be persisted retains its pending recovery marker.

## File-only undo

The private Hosted API adds `GET /session/:id/files/history` and
`POST /session/:id/files/rewind` with a target `promptId` and UUID `requestId`.
Both are live-session-owner scoped and require the existing client identity;
undo additionally requires an idle, writable, unblocked file-tool Session.
The request uses its own acquired runtime Session and restores the saved state.

Before undo effects, persist a pending undo record. Compare every tracked file
against its last observed digest and mode; a subsequent external or Shell
change is a conflict. Reuse `rewind(promptId, false)` to restore existing files
and remove newly created files without deleting backup evidence. Persist the
resulting expected file states before release and completion. A partial restore,
unknown response or persistence failure remains blocked, including after reload.
This is not an atomic multi-file transaction: other writers must be quiescent
throughout undo; a conflict detected before restoration changes no files.
Completed undo receipts remain in subsequent history records, so retrying an
older request after another undo, Write/Edit or reload returns its original
result without reacquiring a released runtime. Receipts share the same bounded
inline record budget as snapshots.

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
