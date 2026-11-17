# Turn admission without the tenant guard

[English](2026-11-03-managed-turn-admission-tenant-guard.md) | [简体中文](2026-11-03-managed-turn-admission-tenant-guard.zh-CN.md)

## Problem and current state

Every Turn submit runs `AgentSessionCommands.insertTurnCommand`, which first takes
the tenant placement guard through `WorkspaceMigrationAdmission.lockTenant`,
bounded at five seconds since [#13800](2026-10-11-managed-tenant-guard-wedge.md).
Every Turn of every Session in a tenant therefore queues on one row, behind
Runtime placement, storage registration, fencing, migration, maintenance, CSI
work and retention, and a long holder turns into `tenant_guard_contended`.

The #13800 design records why the guard is there: a storage migration fence must
exclude new work, and `WorkspaceMigrationStore.prepare` checks that the storage is
idle before it writes the fence. Turn admission and fence installation share the
guard, so a Turn cannot be admitted between the idle check and the fence.

## What already orders Turn admission

Turn admission locks its rows in this order, all in one transaction:

1. The `ma_session` row (`FOR UPDATE`). Lifecycle begin (close, archive, delete)
   locks the same row before it checks for open Turns and operations, so the two
   already serialize on it.
2. For a Workspace Session, `WorkspaceMigrationAdmission.requireOpen` takes
   locking reads of the storage's `ma_storage` alias row, which is also the
   migration fence row, and of its `ma_storage_owner` directory row, and requires
   no fence and a `READY` mount. Physical fencing and restore lock the alias and
   directory rows, and workspace recovery runs only while the directory is
   `FENCED`.
3. It inserts the Turn and its command.

Nothing later in the transaction takes the tenant guard: event append, worktree
readiness and configuration checks use row locks only. Removing the first
acquisition therefore removes a wait edge and adds none.

## The gap and the change

On the migration side, `prepare` takes the guard and then calls
`migrationSource`, which locks every alias row of the physical storage, including
the fence row, through `LocalStorageOwners.lockCovered`. An admission that holds
the fence row has committed before that lock is granted; a later one waits and
then sees the fence. But `migrationSource` reads `ma_storage` without a lock
before taking that lock, so on MySQL the migration transaction's REPEATABLE READ
snapshot can predate it. Without the guard, a Turn committed between that
snapshot and the lock would be invisible to the idle check.

The change has two parts:

- `insertTurnCommand` no longer takes the tenant guard. The Session row lock is
  its first statement, so its own snapshot follows that lock.
- `prepare` runs its idle check (`requireCommittedIdle`) on a separate autocommit,
  read-only connection after `migrationSource` has locked the fence row. This is
  the pattern `LocalStorageOwners.lockCovered` already uses for its authority
  inventory. Every unsettled Turn admitted before the lock is committed and
  visible, and every later admission is refused by the fence.

The other idle checks (`retire` and later phases) run after the fence is
committed, inside transactions whose first reads are locking reads of the fence
row, or outside any transaction, so their snapshots already follow the fence.

## Scope

In scope: Turn submit admission and the migration prepare idle check.

Out of scope, keeping the guard: the other Session commands that take
`WorkspaceMigrationAdmission.lockTenant` (rename, model and approval changes,
MCP and extension management, cwd change, task cancel, context compression,
Session and child insertion, actions), the user message queue's `startNext`
(it still takes the guard before submitting through the same path), lifecycle
operations, Journal writers and publication. Each needs the same audit before its
guard can go. The [Session commands audit](2026-11-03-managed-session-commands-tenant-guard.md)
later removed the guard from most of these commands, including rename.

## Risks

- Turn admission now waits on the storage's alias and directory rows instead of
  the tenant row, so Turns for one storage still serialize briefly there, and a
  migration or physical fence of that storage briefly blocks them.
- Lock order is Session row, then alias, then directory, matching lifecycle
  begin. A guard holder that locked an alias row before a Session row could
  deadlock with it; InnoDB detects that and rolls back one side, which callers
  surface as a retryable failure. No such holder was found.
- The idle check uses one extra pooled connection while `prepare` holds its
  locks. Migration is an administrator operation.

## Verification and acceptance

1. `WorkspaceMigrationStoreTest`: inside a REPEATABLE READ transaction whose
   snapshot is already pinned, a Turn committed from another connection still
   makes `prepare` refuse with `migration_work_unsettled` and install no fence.
2. `ManagedSessionGuardConvoyIT` (MySQL): while another transaction holds the
   tenant guards, Turn submit no longer fails with `tenant_guard_contended`.
3. Existing migration, Turn admission, lifecycle and user message queue suites
   pass, including MySQL in CI.

## Open questions

None for this increment. The remaining Session commands are follow-up work.
