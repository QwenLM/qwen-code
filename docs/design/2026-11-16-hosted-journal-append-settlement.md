# Settle an unacknowledged Hosted journal append

[English](2026-11-16-hosted-journal-append-settlement.md) | [简体中文](2026-11-16-hosted-journal-append-settlement.zh-CN.md)

Status: implemented; validation is recorded in the PR.

## Problem statement

A Hosted turn becomes `hosted_harness_recovery_blocked` when
`POST /transactions:commit` loses its acknowledgement. The authority already
keeps that exact transaction in `unsettledAppend`, and the next append would
ask the durable head whether it landed. The Harness never makes that next
append: it wraps the failure as `HostedToolRecoveryRequiredError` and sets
`session.blocked`. The original writer transaction may still commit or roll
back. Nothing asks again, so the turn stays parked.

The same stall can also time out the macOS storage-identity probe. Warm-up
records that timeout as a terminal `environment.failed` /
`runtime_warm_failed`, which is the signal for an identity that no longer
matches.

## Current state

`JournalCommit.commit` locks the session row with `FOR UPDATE` before its
first consistent read and holds that lock until the writer transaction ends.
The writer budget is 30 seconds (`writerTransactions.setTimeout(30)`). The
client shares one 30 second budget across the commit attempts
(`DEFAULT_REQUEST_TIMEOUT_MS`). This lock order is the session fence from
[the 2026-11-03 design](2026-11-03-managed-journal-commit-tenant-guard.md).
Moving the lock later would let lifecycle admission run during the commit.

On `ManagedSessionAppendUnsettledError`, `LocalManagedSessionAuthority.commit`
stores the marker, events and branches, then throws. `runSerial` calls
`settleUnsettledAppend` only at the start of a later operation. `landed`
applies those events. `absent` drops them and does not submit them again.
Dropping them is wrong while the original transaction can still be holding
the row: the head is unchanged, so the read answers `absent`, and a later
commit of that same transaction fences the authority.

`MacOsHostIdentity.read` uses one `IOException` message,
`macOS native identity probe failed`, both when the probe does not exit
within 5 seconds and when it exits non-zero.
`HarnessCoordinator.runtimeWarmResult` writes `environment.failed` with
`runtime_warm_failed` for every warm-up error.

H2's default lock wait is 2 seconds. Raising it is not this change. A longer
wait queues other commits of the tenant behind one holder.

Checkpoint ownership validation can choose a Session-wide reference index when many commits reuse the same resources. On preserved incident data, the history lookup scanned 11,926 reference entries instead of the two entries for that resource. This adds work while the Session fence is held. Separately, the recovery projection's active-Turn shortcut excludes `HARNESS_RECOVERY_BLOCKED`, so a stopped Harness waiting for durable evidence is reported as `recovering/turn_active` before its evidence is inspected.

## Goals

- A lost commit acknowledgement is settled, or submitted again under the
  same command id, before the Harness parks the session.
- The tool that already ran is not run again. Only its saved journal batch
  is settled.
- A journal fence, a writer lease that cannot be reacquired, and a head
  advanced by a different command still park the session immediately.
- A probe that does not finish within 5 seconds does not record
  `runtime_warm_failed`. A real identity mismatch still does.
- Checkpoint ownership lookups use the resource index while preserving every tenant, Workspace, Session, revision and committed-owner predicate.
- A Harness-blocked Turn exposes its durable recovery evidence instead of the ordinary active-work shortcut.

## Scope boundaries

- The session-row lock stays the first consistent read of `commit` and is
  held until that transaction ends.
- Existing parked Turns are not mutated or replayed by this change. A cancelled Turn can be followed by a new Turn once its existing proof-checked recovery permits admission. Kernel reboot recovery and filesystem identity upgrades belong to a separate change.
- Local JSONL journals have no `settleAppend`. An unknown append there still
  fences the writer.

## Proposed solution

### Same-command resume

`unsettledAppend` also keeps the exact record batch. Before
`commit` throws to the Harness, and again at the start of the next
`runSerial` operation, the authority resumes that batch:

1. `settleAppend` answers `landed`: `applyCommitted` applies the saved
   events. The caller observes a successful commit.
2. `settleAppend` answers `absent`: `appendTransaction` submits the saved
   bytes once. The server replays them when the original transaction
   committed (`operation` + `commandId`, including `transactionId` and
   `recordDigest`). It writes them once when the original transaction rolled
   back. It waits on the session-row lock when the original transaction is
   still open. A lost acknowledgement of this resubmit keeps
   `unsettledAppend`. The `absent` path does not drop the events.
3. The resume wait is separate from the client budget that already expired.
   Its limit is the 30 second writer budget, plus one extra settle read
   after that deadline. Past that point an outcome that is still unknown
   throws `ManagedSessionAppendUnsettledError` and the Harness parks the
   session as it does today.
4. `ManagedSessionJournalFencedError`, a failed writer reacquire, and any
   other definite store failure clear the saved batch, stop this writer, and
   park the session, except for an explicit rollbackable non-commit rejection.
5. `ManagedSessionCommitRejectedError` proves the resubmitted batch did not
   commit. It clears that batch without applying events or stopping the
   writer. The original caller receives its rejection. When a later operation
   settles the old batch before starting, that old rejection is discarded so
   the current operation can proceed and report its own result.

The Harness still sets `session.blocked` only when that final failure
surfaces as `HostedToolRecoveryRequiredError`. A resumed commit returns to
the tool turn as success, and the model loop continues from the committed
records.

### Identity probe timeout

`MacOsHostIdentity.read` throws `MacOsIdentityProbeTimeoutException` when
`waitFor` exceeds 5 seconds. A non-zero exit keeps the existing
`IOException`. `parseBirthTime` still rejects a device, inode or birth time
that does not match.

`HarnessCoordinator.runtimeWarmResult` walks the cause chain and matches
the simple class name `MacOsIdentityProbeTimeoutException`. The control
plane does not depend on `runtime-host`, so it cannot import that type. A
probe timeout is logged and not recorded. Any other warm-up failure,
including an identity mismatch, still appends `environment.failed` /
`runtime_warm_failed` under `runtime:failed:{turnId}`.

## Design decisions

### Checkpoint ownership lookup and recovery projection

`JournalCheckpointValidation.priorCheckpointResourceRevision` supplies `USE INDEX (idx_ma_ref_resource)` for the resource-reference side of the existing ownership join. The lookup keeps its original scope, revision ceiling and committed-journal conditions. It does not move or remove the Session fence. Preserved H2 incident data confirms reference scans fall from 11,926 to two for the history resource; this is query-plan evidence, not a reproduction of the entire original timeout or proof of MySQL behavior.

`SessionRecoveryService.recoveryIntent` includes `HARNESS_RECOVERY_BLOCKED`. Such a Turn now reads Harness evidence and can expose `awaiting_evidence/inputs_unsettled`; an already-ready Harness still waits for control-plane Turn settlement. The separate recheck-intent gate is unchanged, so classification alone cannot replay tools or authorize continuation.

### Existing settlement decisions

- Resume uses the saved bytes because replay compares `transactionId`,
  `commandId`, `recordDigest` and the rest of the commit identity. Encoding
  the events again would mint a new record digest and conflict.
- `absent` resubmits instead of dropping. A head that has not moved is not
  proof the holder rolled back.
- The session-row lock is unchanged. It is what makes the resubmit wait for
  the original transaction and then replay or write exactly once.
- The probe timeout is not an identity change. Recording it as
  `runtime_warm_failed` tells the client the environment is terminal.
- An activation install settles a pending batch before assigning its epoch.
  A resubmitted install can land during settlement and advance the epoch; the
  new install must present the epoch the log then expects.

## Constraints

- No new command id, sequence or tool execution on the resume path.
- The resubmit is one attempt. Its HTTP budget is the store client's own
  request timeout. The authority does not loop that attempt.
- Package-visible warm-up classification stays in `HarnessCoordinator` and
  matches `MacOsIdentityProbeTimeoutException` by simple class name.

## Risks

- A resume that applies `landed` without the bytes having been durable would
  diverge the authority from the store. The resume applies `landed` only
  after `settleAppend`, and applies `absent` only after the resubmit
  returns. The saved batch is the one the failed call tried to write.
- A store outage longer than the 30 second budget still parks the turn.
  That is the existing recovery block, reached later.

## Validation plan

- Authority: a lost acknowledgement with `landed` applies the original
  events on that call. `absent` submits the same command once. A resubmit
  that is also unacknowledged leaves the events in `unsettledAppend`. A
  rejected resubmit clears the batch without stopping later input, including
  when rejection occurs during a later operation's settlement. A fenced
  settle stops the writer. The budget allows one settle read after
  the deadline and does not wait out the wall clock.
- Harness: a prompt whose first journal append loses its acknowledgement and
  then settles `landed` finishes with `recoveryBlocked` false. A fenced
  append finishes with `recoveryBlocked` true.
- Java: `/bin/sleep 20` throws `MacOsIdentityProbeTimeoutException`. A
  timeout cause does not append `environment.failed`. An identity-mismatch
  `IOException` does.
- Ownership SQL: repeated references do not cause a Session-wide reference scan. Missing resources, foreign scope, future revisions and an uncommitted or orphan journal owner remain rejected. Real MySQL 8.4 acceptance remains a required separate check.
- Recovery projection: a stopped Harness with unsettled input reports `awaiting_evidence/inputs_unsettled`, and a ready Harness with an active control-plane Turn reports `turn_settlement_pending`. Neither case dispatches or replays work through the query path.

## Acceptance criteria

- The session-row `FOR UPDATE` remains the first consistent read in
  `JournalCommit.commit`.
- An unacknowledged commit is not dropped on `absent`.
- The Harness does not set `session.blocked` when that commit later settles
  or is replayed.
- A probe timeout does not emit `runtime_warm_failed`. An identity mismatch
  still does.
- Resource-index selection preserves all ownership predicates and the existing Session fence.
- Recovery status matches the Harness evidence without widening the recheck or continuation gates.
