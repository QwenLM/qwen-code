# Workspace execution membership without the tenant lock

[English](2026-11-03-managed-workspace-membership-cas.md) | [简体中文](2026-11-03-managed-workspace-membership-cas.zh-CN.md)

## Status and scope

Status: Implemented. Focused H2 and existing MySQL recovery and inventory cases
have passed. The dedicated MySQL concurrency cases below supplement that
evidence; their execution results are recorded in the PR validation report.
Full acceptance remains pending the required CI gates.

This change replaces the serialization of ordinary Workspace execution
membership. Today every tool-call admission, release, and file rewind of a
LOCAL or SSH_LOCAL directory takes the tenant-wide placement guard, locks the
physical directory row, and scans the directory's member rows under
`FOR UPDATE`. After this change the same operations run a pre-check outside
any lock and then one short conditional update of the directory row, which
carries the directory's occupancy as summary columns. The directory row stays
the single point every writer of that directory touches; the tenant guard no
longer participates in this domain.

The membership model itself is unchanged and remains the one defined by
[Concurrent Managed Workspace Sessions](2026-10-21-managed-workspace-concurrency.md):
per-Runtime-Session membership, shared ordinary execution, exclusive rewind,
and zero-membership physical steps. This change only changes how those rules
are enforced. It exists because the current enforcement is what couples
unrelated work: the tenant guard is the mechanism named by
[Bounded tenant-guard coupling](2026-10-11-managed-tenant-guard-wedge.md), and
the member scan takes gap locks on a non-unique index, which is what makes
unrelated tenants queue on one physical record when the clustered index
changes shape.

## Problem and current behavior

`claim` runs before every tool call, entered from
`WorkspaceRuntimeTransport.acquire`. For LOCAL and SSH_LOCAL storage its
transaction in `WorkspaceExecutionStore.claim` does, in order:

1. The tenant placement guard through `WorkspaceStorageKindGuard.lockDomain`,
   with no statement timeout, so the wait is bounded only by
   `innodb_lock_wait_timeout`.
2. The storage alias row `FOR UPDATE` and then the physical
   `ma_storage_owner` row `FOR UPDATE`, both inside `storageKey`.
3. The Runtime binding row and the Runtime Session row `FOR UPDATE`.
4. An `INSERT ... ON DUPLICATE KEY UPDATE` of the directory row that the
   preceding step already proved to exist, followed by a second
   `FOR UPDATE` of the same row.
5. The mount verification, including filesystem identity checks, while all of
   the above locks are held (`storageGuard.verifyLocked`).
6. The membership scan
   `SELECT ... FROM ma_runtime_session WHERE execution_storage_key = ? FOR UPDATE`.
   The predicate uses the non-unique index `idx_ma_runtime_execution_storage`,
   so the scan takes gap locks.
7. Java-side checks (`holder_key` and `maintenance_id` null, no other member
   exclusive), then the membership `UPDATE`.

`release`, `beginRewind`, `endRewind`, `holdForMaintenance`, and `releaseLost`
each repeat the tenant guard and the directory lock, and the two that inspect
occupancy repeat the scan.

Three properties of this shape are the problem:

- The tenant guard is one row per tenant. Every tool call of every directory
  of the tenant queues on it, so a long holder stalls turns it has nothing to
  do with. This is the coupling the tenant-guard design already forbids on
  the lanes it covers; the membership lanes were left holding the guard.
- The membership scan's gap locks make the outcome depend on index layout. A
  surrogate primary key moves every insert to the same end-of-index record,
  and inserts for different tenants then wait on one lock. That failure was
  observed on real MySQL 8.4 against the surrogate-key baseline.
- The verdict is computed in Java from rows read earlier in the transaction.
  A plain read placed before a lock wait pins the REPEATABLE READ snapshot
  too early, and the retry then acts on state it cannot see. Two such defects
  were found and fixed in the tenant-guard change; the fix in each case was
  to move the read, which no reviewer can see from the code.

## Goals

- G1: Admitting, releasing, or rewinding execution on one directory never
  waits on the tenant placement guard, and does not scan
  `idx_ma_runtime_execution_storage` with gap or next-key range locks.
  Updating membership still takes the index record locks needed for the write.
- G2: Two directories, whether of one tenant or of two, admit execution and
  check occupancy without blocking each other.
- G3: The occupancy rules are: shared ordinary
  members (including uploads), exclusive rewind, maintenance exclusion, zero-member
  physical steps, exact release, lost-worker cleanup scoped to one binding
  and generation, and retention that preserves bindings with members.
- G4: Every condition that decides success or failure is in an
  `UPDATE ... WHERE` predicate or a current locking read of a row this
  transaction has already point-locked. A snapshot read decides nothing.
- G5: The locks one transaction holds are a documented order, and no
  transaction in this domain takes two of them in another order.

## Non-goals

- CSI reservation, CSI retirement, and the resident profile's admission. The
  resident branch of `claim` and `release` keeps its current shape, including
  its tenant guard.
- The tenant guard held by other domains: Runtime placement, publication,
  migration fence installation, lifecycle admission, and retention sweeps.
- Replacing the primary keys of the shared baseline. This design assumes the
  current baseline, where `ma_storage_owner.id` is the surrogate primary key
  and `storage_key` remains the unique business key.
- Public routes, the Harness protocol, and WebShell.

## Design

### D1. Occupancy summary on the directory row

Add two columns to `ma_storage_owner`:

- `member_count BIGINT UNSIGNED NOT NULL DEFAULT 0`, the number of `ma_runtime_session`
  rows whose `execution_storage_key` equals this row's `storage_key`, plus `RUNNING`
  `WORKSPACE_UPLOAD` operations whose `physical_key` equals it.
- `exclusive_member_key CHAR(64)`, null unless one member holds exclusive
  rewind. Its value is the existing SHA-256 key of the binding id, runtime
  generation, and runtime session id, the same construction operator recovery
  already uses for its holder key.

And two `CHECK` constraints:

- `member_count >= 0`.
- `exclusive_member_key` is null or `member_count >= 1`.

A third constraint, forbidding a holder while members exist, is not added.
`holder_key` is also the signal that release and `isHeld` use to refuse a
directory that gained a holder while members were still recorded, and recovery
tests plant that combination. Production writers still require
`member_count = 0` before they set `holder_key` or `maintenance_id`.

The member rows stay. `execution_storage_key` and `is_execution_exclusive` remain
the source of truth for every consumer whose question is about one binding or
one Session rather than about the directory: retention, lost-worker cleanup,
operator recovery, stopped-session release, worktree cleanup, and the CSI
inventory. The summary answers only directory-level questions, and only the
write paths listed in D4 may change it.

### D2. No tenant guard on per-call membership

This applies to Runtime execution membership and to upload admission and
completion (`WorkspaceFileUploadStore.admit` and `finish`); see the
[shared uploads design](2026-11-03-managed-shared-workspace-uploads.md).

`claim`, `release` (including mount handback), `beginRewind`, and `endRewind`
stop calling `WorkspaceStorageKindGuard.lockDomain` on the LOCAL and
SSH_LOCAL paths.

Operations that are not per call may keep the guard where another domain
requires it: physical registration, fencing, restoration, migration,
maintenance, lost-worker cleanup, operator recovery, and retention. Their
membership correctness must not depend on it. Each of them already locks the
directory row, and the summary makes that row sufficient.

### D3. Admission is a pre-check plus one short conditional update

`claim` splits in two.

Outside any transaction it reads the binding, the session, the alias, and the
directory row, and it runs the mount verification it runs today. This read
exists to fail fast and to capture `mount_revision`; it decides nothing.

It then opens a transaction of three statements and commits immediately:

```sql
UPDATE ma_storage_owner
   SET member_count = member_count + 1
 WHERE storage_key = ?
   AND mount_state = 'READY'
   AND mount_revision = ?
   AND holder_key IS NULL
   AND maintenance_id IS NULL
   AND exclusive_member_key IS NULL;

SELECT binding_state, runtime_generation, is_drain_requested
  FROM ma_runtime_binding
 WHERE binding_id = ?
   FOR SHARE;

UPDATE ma_runtime_session
   SET execution_storage_key = ?
 WHERE binding_id = ?
   AND runtime_generation = ?
   AND runtime_session_id = ?
   AND harness_session_id = ?
   AND session_state IN ('ACQUIRING', 'READY')
   AND execution_storage_key IS NULL;
```

`mount_revision` is the value read by the pre-check. Zero affected rows on the
first statement is `workspace_busy`; zero on the third is `unavailable`. A binding
row that is no longer `READY` at the same generation, or that has
`is_drain_requested`, rolls the transaction back with `unavailable`.

The `FOR SHARE` read locks the single binding row in addition to the directory
and session records locked by the updates. It exists so that a binding
transition to `DRAINING` or `LOST` that commits before this transaction cannot
be followed by a new member. It is not a directory lock and not a tenant lock.
H2 has no share-lock syntax, so the H2 tests take `FOR UPDATE` on that one
row. MySQL and MariaDB use `FOR SHARE`.

The transaction holds its locks only for the duration of those statements. The
filesystem checks happen before it opens.

### D4. Every membership write maintains the summary in the same transaction

| Path                                              | Member rows                                                 | Directory row, same transaction                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `WorkspaceFileUploadStore.admit`                  | inserts one running upload operation                        | `member_count + 1` at the scope's `mount_revision`; no holder, maintenance or rewind            |
| `WorkspaceFileUploadStore.finish`                 | settles one running upload operation                        | `member_count - 1`; a terminal replay changes neither row                                       |
| `WorkspaceExecutionStore.claim`                   | sets `execution_storage_key` for one session                | `member_count + 1` under the D3 predicate                                                       |
| `WorkspaceExecutionStore.release`                 | clears the key and `is_execution_exclusive` for one session | `member_count - N`; clears `exclusive_member_key` when it equals this member and `N > 0`        |
| `WorkspaceExecutionStore.releaseLost`             | clears every member of one binding and generation           | `member_count - N` for the one physical key those rows share                                    |
| `JdbcRuntimeBindingRepository.clearStoppedMember` | clears one session's key and exclusivity                    | `member_count - 1`; clears `exclusive_member_key` when it equals this member                    |
| `WorkspaceExecutionStore.beginRewind`             | sets `is_execution_exclusive`                               | sets `exclusive_member_key` where `member_count = 1`, the mount is `READY`, and the key is null |
| `WorkspaceExecutionStore.endRewind`               | clears `is_execution_exclusive`                             | clears `exclusive_member_key` where it equals this member                                       |
| `JdbcRuntimeRetention` session delete             | deletes `RELEASED` or `FAILED` session rows                 | none; the predicate gains `execution_storage_key IS NULL`, so a member row is never deleted     |

`N` is the affected-row count of the member-row statement in the same
transaction, and the directory statement subtracts exactly `N`. A directory
statement that changes zero rows rolls the transaction back. Nothing repairs a
mismatch in place. Guarded decrements and `CHECK` constraints reject underflow
and contradictory exclusivity; invariant tests compare the count with its rows.

Because retention deletes session rows without passing through a membership
write, its delete predicate must exclude rows that still carry a membership.
Deleting a member row would decrement nothing and leave the summary high.

### D5. Directory-level questions read the summary

These paths currently scan member rows to learn whether a directory is empty
or busy. Each instead reads `member_count` and `exclusive_member_key` from the
directory row it already locks:

- `WorkspaceExecutionStore.holdForMaintenance`, which requires
  `member_count = 0` before taking `holder_key` and `maintenance_id`.
- `WorkspaceFileUploadStore.admit`, which requires null holder, maintenance and
  exclusive-rewind keys, then adds shared membership. Other members may remain.
- `WorkspaceStorageGuard`: registration, `fence`, `restoreOriginal`,
  `requireFenced`, and the occupancy half of `inspect`.

`hasExecutionMembers` is deleted. The paths that need a specific member's
identity are not directory-level questions and keep reading member rows:
`ManagedRuntimeRetentionGuard.bindingReferenced`,
`JdbcRuntimeBindingRepository.hasExecutionMembership`,
`WorkspaceOperatorRecoveryStore.holder`,
`SessionWorktreeStore.cleanupBlocker`, and the CSI inventory and checkpoint
reads.

### D6. What a predicate must carry

Three rules apply to every path this change touches.

A condition decides an outcome only inside an `UPDATE ... WHERE`, or as a
current locking read of a row this transaction has point-locked. The pre-check
reads exist to fail fast and to bind parameters. This removes the class of
defect in which a plain read placed before a lock wait pins the transaction's
snapshot too early.

In particular, `WorkspaceStorageGuard` reads the membership count with
`FOR UPDATE` for registration, fencing, restore and fenced-authority checks.
The MySQL fence contender reproduced a stale zero count from a plain read even
after the directory lock had been acquired. A previously established
REPEATABLE READ snapshot is not refreshed by acquiring that lock. Diagnostic
inspection keeps its nonlocking read.

Affected-row counts are checked only for statements that change a stored
value. MySQL and MariaDB Connector/J report matched rows by default rather
than changed rows, and H2 does the same, so an update that writes a column's
current value back cannot be told apart from one that matched nothing.

The redundant statements go away. `claim` drops its
`INSERT ... ON DUPLICATE KEY UPDATE` of the directory row and the second
`FOR UPDATE` that follows it, and `holdForMaintenance` drops the same pair.
Both already require the row to exist before they reach it.

### D7. One lock order

A transaction that locks more than one of these takes them in this order.
Directory and binding locks use unique point lookups; the removed occupancy
scan must not acquire member-index range locks. Session writes can still lock
other secondary-index ranges, which is outside this narrower guarantee:

1. The tenant placement guard, only where D2 still allows it.
2. Alias rows in `ma_storage`, in ascending `alias_key` order.
3. The directory row in `ma_storage_owner`.
4. Operation and work rows in `ma_operation` and `ma_operation_work`.
5. The binding row in `ma_runtime_binding`.
6. Session rows in `ma_runtime_session`.

`claim` takes 3 then 5. The transactions that share locks with it and run in
another order today are:

- `WorkspaceOperatorRecoveryStore.prepare` locks the binding row and then,
  inside `holder`, the directory row. It also locks the tenant guard first.
  Once `claim` no longer takes the guard, the two form a cycle the guard
  currently breaks. `prepare` locks the directory row before the binding row.
- `WorkspaceExecutionStore.releaseMaintenance` locks the maintenance work row
  through `WorkspaceMaintenanceRecovery.recordReturned` and then updates the
  directory row, while `holdForMaintenance` locks the directory row and then
  writes work rows through `recordStart`. `releaseMaintenance` locks the
  directory row first and re-checks the returned work under that lock.
- `JdbcRuntimeBindingRepository.admitExecution` locks the binding row and then
  the directory row, inside `requirePhysicalStorageAdmission`. The execution
  admission locks the directory row before it locks the binding row. It only
  needs the directory's `mount_state`, so the directory lock is a point lock
  with no preceding alias lock. `admitSession` does not lock the directory
  row; its binding-then-session order already matches.

The remaining multi-row transactions in this domain already follow the order:
upload `admit` locks the alias row, then the directory row, then inserts its
operation row, and upload `finish` locks the directory row before its operation
row; `fence` and `restoreOriginal` lock the guard, then alias rows through
`LocalStorageOwners.lockCovered`, then the directory row; registration and
migration source reads do the same; `releaseLost` locks the guard, the
directory row, then the binding row.

## Why not the alternatives

Dropping the directory row as well as the tenant guard was considered. The
rules to preserve compare rows that are written separately: one Session's
membership row, another Session's membership row, and the directory's
maintenance columns. With no row that every writer touches, both sides of a
race read a state the other has not changed yet and both writes succeed. A
unique index can limit an exclusive holder to one and cannot express "shared
occupancy blocks exclusivity". An external lock or routing one directory's
writes to one process moves the shared point out of the database and adds
leader election, fencing, and failover. The conditional update keeps the
shared point and holds it for the length of the statements instead of the
length of the checks.

## Risks

- **The summary drifts from the member rows.** Every membership write is in
  the D4 table, subtraction uses the affected-row count of the write it
  follows, retention cannot delete a member row, and the `CHECK` constraints
  reject a contradictory summary. The subtraction is also guarded in the
  statement: it updates `WHERE member_count >= N`, so a count that cannot
  cover the rows just cleared matches nothing and rolls the transaction back
  instead of depending on how the engine treats an unsigned underflow. The new tests assert equality
  after every scenario. A drift still fails closed rather than being repaired,
  so a missed write path surfaces as a rollback instead of a slow divergence.
- **Removing the guard exposes lock cycles it used to hide.** The known
  reversals are the three in D7, and the order is checkable by listing the
  lock acquisitions per transaction. The new deadlock test drives the one
  pair that shares both the directory row and the binding row.
- **A pre-check passes and the directory changes before the update.** The
  conditional update carries `mount_state` and `mount_revision`, and every
  transition that must invalidate an admission writes one of them. The
  invalidation inventory below records which transition writes which column. A
  transition that writes neither would admit against a stale check, so any new
  directory state has to update the row.
- **The baseline is also being reworked.** The column types and index names
  follow the baseline as merged. The summary columns and their constraints are
  added to that baseline in the same change; they are not a reason to take the
  surrogate primary key.

## Invalidation inventory

Each transition that must make an in-flight `claim` fail, and the directory
write that makes the conditional update fail. All of them already update
`ma_storage_owner`.

| Transition                   | Writer                                                             | Directory change                                             |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Fence                        | `WorkspaceStorageGuard.fence`                                      | `mount_state = 'FENCED'`                                     |
| Restore                      | `WorkspaceStorageGuard.restoreOriginal`                            | `mount_state = 'READY'`, `mount_revision` incremented        |
| Registration completes       | `WorkspaceStorageGuard` registration, `SshWorkspaceStore.publish`  | `mount_state = 'READY'`, `mount_revision` set or incremented |
| Maintenance hold and release | `holdForMaintenance`, `releaseMaintenance`, `reconcileAfterReboot` | `holder_key` and `maintenance_id` set or cleared             |
| Upload occupancy             | `WorkspaceFileUploadStore.admit` and `finish`                      | `member_count` incremented or decremented                    |
| Exclusive rewind             | `beginRewind`, `endRewind`                                         | `exclusive_member_key` set or cleared                        |
| Alias removed                | `SshWorkspaceStore.releaseParked`                                  | deletes the `SSH_LOCAL` owner row                            |

Two transitions do not change the directory row and do not need to. Migration
writes `fence_operation_id` on the tenant's fence row in `ma_storage`, and
both `claim` and `holdForMaintenance` already call
`WorkspaceMigrationAdmission.requireOpen` before the conditional update.
`requireOpen` locks that fence row when it runs inside the transaction, so a
fence that commits first is visible and one that has not committed yet blocks
on the fence row. An alias retarget updates the alias row's `physical_key`
while holding the alias row; the admission resolves the physical key by
reading the alias row under the same directory lock, so it sees the committed
target.

## Lock-order inventory

Transactions that take point locks on two or more of the tenant guard, alias
rows, the directory row, operation or work rows, the binding row, and session
rows. "Change" names the reordering D7 requires; the others already match.

| Transaction                                      | Order today                                        | Change                                        |
| ------------------------------------------------ | -------------------------------------------------- | --------------------------------------------- |
| `claim`, `beginRewind`                           | guard, alias, directory, binding, session          | drop the guard                                |
| `release`                                        | guard, alias, directory, binding                   | drop the guard                                |
| `holdForMaintenance`                             | guard, alias, directory, operation, then work rows | none                                          |
| `releaseMaintenance`                             | guard, work row, directory                         | directory before the work row                 |
| `releaseLost`                                    | guard, directory, binding, session                 | none                                          |
| `clearStoppedMember`                             | guard, alias, directory, binding, session          | none                                          |
| `admitExecution`                                 | guard, binding, alias, directory                   | directory before the binding                  |
| `compareAndSet`, `recoverLost`                   | binding control, guard, slot, binding              | none                                          |
| `WorkspaceOperatorRecoveryStore.prepare`         | guard, binding, directory, session                 | directory before the binding                  |
| `WorkspaceStorageGuard.fence`, `restoreOriginal` | guard, aliases, directory, then the member scan    | member scan replaced by the summary           |
| `WorkspaceFileUploadStore.admit`                 | guard, operation, directory, then the member scan  | drop the guard; alias, directory, operation   |
| `WorkspaceFileUploadStore.finish`                | guard, operation, directory                        | drop the guard; directory before operation    |
| `WorkspaceMigrationStore` fence installation     | guard, alias fence row                             | none                                          |
| `JdbcRuntimeRetention` sweep                     | guard, slot, binding, executions, sessions         | none; the session delete excludes member rows |

## Validation

### Existing coverage that must stay green

- `WorkspaceRecoveryContract`, run through `WorkspaceRecoveryTest` on H2 and
  through `ManagedAgentMySqlIT#originalWorkspaceHoldersRecoverWithoutCurrentAuthority`
  on MySQL: shared membership, rewind, maintenance exclusion, lost cleanup,
  and operator preparation.
- `WorkspaceRuntimeTest`: concurrent admission from two connections, exact
  release, mount handback, and rewind under contention.
  `heldTenantGuardDoesNotBlockMembershipChanges` holds the tenant placement
  guard and still completes claim, rewind, and release, then checks
  `member_count`.
- `JdbcPhysicalStorageReleaseTest`, reached on MySQL through
  `JdbcRuntimeBrokerMySqlIT`: exact release per alias.
  `verifyCleanupOrdering` asserts that cleanup waits on the directory row and
  that a session row stays lockable while it waits; it is rewritten to follow
  the D7 order.
- `ManagedRuntimeRetentionGuardTest` and its MySQL subclass, the retention
  race tests, `WorkspaceStorageGuardTest`, `WorkspaceFileUploadStoreTest` and
  its MySQL subclass, and `HostedWorkspaceConcurrencyIT`.

### Schema contracts

The columns and constraints land in the shared V1 baseline, edited in place
per the module's schema policy. `ManagedSchemaProjection.STORAGE_OWNER` gains
both columns. The CSI inventory assertions that compare whole
`ma_storage_owner` rows, in `WorkspaceCsiApplicationInventoryTest` and its
MySQL subclass, are regenerated against the new row shape.
`ManagedSchemaTest` drift checks cover the new constraints without further
changes.

### New MySQL coverage

`WorkspaceExecutionMembershipMySqlIT` runs against disposable MySQL 8.4.
The concurrency cases observe `performance_schema.data_locks` or the lock-wait
graph while the transactions are still open, before releasing their blockers:

- An external transaction holds the tenant placement guard for the whole run.
  `claim`, reentrant `claim`, rewind start/end, release and repeated release on
  that tenant's directory all complete.
- Two connections admit execution on two different directories, for both one
  tenant and two tenants. Both reach a pause immediately before commit without
  waiting on each other. The live snapshot contains directory record locks;
  any locks on `idx_ma_runtime_execution_storage` must be record-only
  (`REC_NOT_GAP`), with no member-scan range locks.
- `WorkspaceOperatorRecoveryStore.prepare` waits on a deliberately held binding
  row while already holding the directory row. A reentrant `claim` then queues
  behind it. Releasing the blocker lets preparation finish and rejects the
  claim, with no increase in the server's deadlock counter.
- A pending membership commit blocks fencing and maintenance, which refuse
  after that commit. Each physical operation succeeds after membership is
  released, providing a positive control. A pending exclusive rewind similarly
  blocks and then rejects another member; admission succeeds after rewind ends.
- After every scenario, `member_count` equals the number of session rows
  carrying that `execution_storage_key` plus running upload operations for the
  physical key, and `exclusive_member_key` matches
  the one exclusive member or is null.

H2 does not exercise InnoDB gap locks or deadlock detection, so it is not
evidence for the locking claims. The selected MySQL cases run locally within
the module's verification budget; the full MySQL matrix stays with CI.

## Acceptance criteria

1. No per-call membership path acquires the tenant placement guard, and a held
   guard does not delay `claim`, `release`, or rewind.
2. Distinct directories never block each other's admission or occupancy
   checks, and occupancy checks take no member-index gap or next-key range
   locks. Membership writes may hold index record locks.
3. The occupancy outcomes listed under G3 hold on the affected suites.
4. `member_count` matches Runtime members plus running uploads, and
   `exclusive_member_key` matches the sole rewind member after every
   tested scenario, and a write that would break the `CHECK` constraints rolls
   back.
5. The transactions in the lock-order inventory acquire locks in the D7 order,
   and the concurrent `claim` and operator-prepare case reports no deadlock.

## Open questions

None.
