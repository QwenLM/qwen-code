# Daemon Session Maintenance Writer Lease

> **Proposed Conversations-runtime update (2026-09-02):**
> [Relaxed Standalone Daemon Ownership](./2026-09-02-relaxed-standalone-daemon-ownership.md)
> for [Issue #10810](https://github.com/QwenLM/qwen-code/issues/10810) would
> supersede this document's always-`reclaimPolicy: 'never'` rule for standalone
> lifecycle and maintenance acquisitions on the Conversations runtime. Those
> acquisitions would use the hardened `local` policy; daemon maintenance for
> ordinary workspaces and other managed runtimes keeps `never`.

## Problem

The daemon can delete, archive, or unarchive a persisted transcript after its
in-process ACP owner has closed. A different daemon process can still own the
same transcript, so the in-process archive coordinator alone does not prevent
the daemon from racing an external writer.

The transcript path and writer-lock path must also be resolved from the same
workspace runtime. Falling back to the primary daemon runtime can mutate one
workspace while checking a lock in another.

## Scope

This change covers daemon-owned maintenance:

- REST and ACP delete, archive, and unarchive requests
- disconnect and orphan cleanup
- scheduled-task rollback and keepalive cleanup
- daemon shutdown while maintenance is already running

It does not add lease expiry, heartbeat, hostname-based recovery, automatic
steal, force unlock, or a lock-schema migration. Writers that do not participate
in the lease protocol still require platform-level single-writer fencing.

## Runtime storage binding

Each `WorkspaceRuntime` resolves one absolute session runtime base directory at
creation. Resolution keeps the existing priority:

1. `QWEN_RUNTIME_DIR`
2. `advanced.runtimeOutputDir`, resolved relative to the workspace
3. the normal Qwen runtime directory

The resolved directory is stored on the runtime and injected as
`QWEN_RUNTIME_DIR` into every managed ACP child. Environment reload may update
other values but preserves this pinned value because changing
`runtimeOutputDir` requires a runtime restart.

Daemon parent operations that list, read, export, organize, or maintain
sessions run inside the selected runtime's storage context. Runtime resolution
failures do not fall back to the primary runtime.

## Lease API

`SessionService.acquireSessionWriterLease()` derives both the writer-lock root
and the active transcript path from the service's fixed `Storage` instance.
Callers provide only the session ID, process kind, version, and reclaim policy.
Invalid session IDs are rejected before the lock directory is touched.

Daemon maintenance always uses `processKind: 'daemon'` and
`reclaimPolicy: 'never'`. The existing lock schema, key, owner record, and
acquire/release protocol remain unchanged.

## Maintenance protocol

Every session is processed independently:

1. Enter the daemon's per-session exclusive archive coordinator.
2. Close the local owner. Archive requires agent close; delete uses the normal
   fast close. A missing local owner is allowed.
3. Classify persisted state and preserve existing not-found and idempotent
   results without creating a lock.
4. Acquire the daemon writer lease.
5. Reclassify while holding the lease.
6. Verify ownership and the transcript fingerprint, then perform one mutation.
7. Release the lease with owner-token verification.

Batch requests may process independent sessions concurrently, but a worker
holds at most one cross-process lease and never waits while holding multiple
leases.

A failed mutation remains the reported error when release succeeds. A release
or ownership failure is the externally safe error even if mutation also failed.
Logs record the workspace, session, action, error kind, and whether the
transcript mutation reached disk; they never include owner tokens or lock
paths. Scheduled-task reconciliation follows the actual transcript mutation,
not whether lease release subsequently succeeded.

Orphan cleanup first closes the local owner and respects
`requireZeroAttaches`. A newly attached owner therefore prevents deletion.
Late-spawn cleanup awaits close before acquiring the lease and deleting the
transcript.

## Shutdown

`SessionArchiveCoordinator.sealMaintenanceAndWait()` synchronously rejects new
exclusive maintenance and waits for exclusive operations already admitted.
Shared transcript reads are not included, so a long export does not consume the
termination budget. REST returns `503 daemon_draining`; ACP returns a JSON-RPC
server error with `data.errorKind = daemon_draining`.

Daemon shutdown seals maintenance before child/process teardown and completes
only after admitted maintenance leases have been released.

## Compatibility and rollout

Batch response shapes and existing archive/delete/unarchive idempotency
remain unchanged. Pre-check local `session_archiving` conflicts (raised by
`assertNotTransitioning` before admission) still surface as a request-level
`409`. Conflicts raised inside the admission gate are reported per session in
the `200` response body (`errors[]`) for archive, unarchive, and delete
alike. Mixed-version writers are unsafe, so deployment and rollback must
drain the old daemon and managed ACP processes before starting the new
version.

## Verification

Tests use real temporary runtime roots for writer contention and root
isolation, cover state changes between the initial and locked classifications,
and verify close, mutation, release, scheduled-task reconciliation, and
shutdown ordering. Unit tests also cover invalid IDs, duplicate IDs,
active/archive conflicts, lease release failures, orphan reattachment, and log
redaction. Relevant package tests, build, and typecheck are required before
merge.
