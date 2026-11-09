# Tool execution admission without tenant placement

[English](2026-11-05-managed-admission-placement.md) | [简体中文](2026-11-05-managed-admission-placement.zh-CN.md)

Status: implemented. This is part (b) of
[2026-11-05-managed-dispatch-tenant-guards](2026-11-05-managed-dispatch-tenant-guards.md).

## Problem

After part (a), dispatch of an ordinary session-class binding takes no tenant guard,
and admission takes no publication guard. `JdbcRuntimeBindingRepository.admitExecution`
still took tenant `runtime_placement` first, unconditionally. Every tool call of a
tenant therefore still queued once on the tenant placement row, behind binding
transitions, provisioning, retention, maintenance, collectors and writer acquisition.

## What placement orders for admission

Admission reads several fences with plain reads. Placement made each read ordered
against the writer of that fence:

| Fence                                | Writer and its locks                                                                           | What admission does                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| Harness drain (`DRAINING`)           | `requestHarnessDrain`: placement only                                                          | plain read of the `ma_session_head` row |
| Lifecycle begin (`LIFECYCLE_ONLY`)   | `beginLifecycle` → `beginHarnessLifecycle`: the Session root (`requireLegacySessionForUpdate`) | same read                               |
| Lifecycle effects (`DRAINING`)       | `WorkspaceLifecycleStore.saveLocked`: placement, publication guard, Session root               | same read                               |
| Storage fence (`fence_operation_id`) | `requestStorageFence` (placement), Workspace migration (migration authority)                   | plain read of `ma_storage`              |

- **Lifecycle phases already hold the Session root.** Since part (a), admission of an
  ordinary binding holds that root through commit, so it is ordered against them
  without placement.
- **The storage fence has a backstop.** Migration's `assertRetired` requires every
  binding of the storage `RELEASED` and no unsettled execution. A binding leaves
  `READY` under its row lock, which admission holds, so an execution admitted beside a
  new fence blocks the migration as `migration_work_unsettled`. It never slips past.
- **The harness drain fence was the gap.** `requestHarnessDrain` took no row that
  admission takes.

## Storage rows

For a binding with a storage id, admission (`requireStorageAdmission` →
`requirePhysicalStorageAdmission` → `localStorageOwnerKey`) locks the `ma_storage`
alias row `FOR UPDATE` after the binding, and for `LOCAL` storage also the
`ma_storage_owner` row. Workspace-bound Sessions always carry a storage id.

A cycle with a placement-free admission (root → binding → alias → owner → Runtime
Session → execution) needs a transaction that either:

- holds an alias or owner row and then waits for a Session root, a binding, a Runtime
  Session or an execution; or
- holds a Runtime Session or execution without first locking its binding, and then
  waits for an alias or owner row.

A transaction that locks the same binding first is serialized with admission there,
whatever it locks next. Audit of the `LOCAL` alias and owner lockers:

| Transaction                                                                         | Order                                                            | Result                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| `createSession`, admission under placement                                          | binding → alias → owner → Runtime Session                        | same order                      |
| `WorkspaceExecutionStore.admit`                                                     | binding (shared) → Runtime Session → owner                       | meets admission at the binding  |
| `WorkspaceExecutionStore` release paths                                             | binding → Runtime Session → owner                                | meets admission at the binding  |
| `WorkspaceFileStore` scope                                                          | root → alias                                                     | same order                      |
| `LocalStorageOwners.lockCovered`                                                    | aliases, then a separate nonlocking read of authorities          | locks no binding after an alias |
| Worktree and child workspace claims, maintenance recovery, upload, migration, fence | alias or owner, no binding, Session or execution lock after them | no cycle                        |
| `completeStoppedSessionRelease`                                                     | alias → owner → binding → Runtime Session                        | **reversed**                    |

`LocalStorageOwners.lockCovered` already states the convention: admissions wait on the
aliases, and nothing reverses the binding locks. `completeStoppedSessionRelease` was
the one exception, kept safe by placement. It now locks the binding right after
placement and before the storage rows. It holds placement, so its order changes
nothing against other placement owners.

The `SSH_LOCAL`, `CSI` and `EXTERNAL` lockers were not audited, so the fast path is
limited to bindings without storage, or with a missing or `LOCAL` alias. An alias's
kind does not change in place.

## Design

1. **Drain takes the Session root.** `requestHarnessDrain` locks the Session root
   (`ExecutionAdmissionPlacement.lockDrainRoot`) after placement and before it writes
   the head row. Placement → root is the order every placement owner already uses.
   The callers (`ManagedRuntimeCoordinator.requestWorkspaceClose`, through
   `SessionLifecycleCoordinator`) run it in its own transaction, outside any database
   transaction.
2. **Placement-free admission.** Before the transaction, next to the existing
   `findById`, `ExecutionAdmissionPlacement.free` decides with plain reads on their own
   connection. It requires all of these:
   - the binding is outside the CSI files profile and not a Resident Workspace;
   - `isolationClass = session`, and it does not share Runtime Sessions;
   - no lifecycle authority (such a check already share-locks the head row);
   - the Session root of the isolation key exists;
   - no storage, or a missing or `LOCAL` alias.

   Otherwise admission takes placement first, as before.

3. **The root is the first statement.** Under REPEATABLE READ, the first plain read of
   a transaction fixes its snapshot. `lockExecutionControl` starts with a plain read of
   the binding, so on the fast path `ExecutionAdmissionPlacement.lockEntry` locks the
   Session root before anything else. Every later plain read, the head row included,
   sees all commits made before the root was granted. A root deleted after the
   pre-read is refused as `runtime_admission_closed`.

### Why this is enough

- **Drain commits first.** It held the root until it committed. Admission's root lock
  is granted after that, and its head read sees `DRAINING`, so admission refuses.
- **Admission commits first.** Drain waits for the root until admission commits. The
  execution is then durable before `DRAINING`, exactly like an execution admitted just
  before the fence before this change. The later drain steps settle it, and
  `verifyHarnessStopped` locks the bindings and checks executions as before.
- **Lifecycle phases** are ordered by the same root.

### Resulting orders

| Path                            | Order                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| Admission (fast path)           | root → binding → (alias → owner) → Runtime Session → execution             |
| Admission (otherwise)           | placement → root → binding → (alias → owner) → Runtime Session → execution |
| Dispatch (non-Resident)         | root → binding → Runtime Session → execution                               |
| `requestHarnessDrain`           | placement → root → head                                                    |
| `completeStoppedSessionRelease` | placement → binding → alias → owner → head → Runtime Session               |
| `verifyHarnessStopped`          | placement → head → bindings → Runtime Sessions (behind the lifecycle root) |
| Runtime retention               | placement → slot → binding → executions → Runtime Sessions                 |

## Verification

- `ExecutionControlTenantGuardsTest` (H2) and `ExecutionControlTenantGuardsMySqlIT`:
  - admission completes while placement and the publication guard are both held;
  - without a Session root, admission keeps waiting for placement;
  - `requestHarnessDrain` waits while another transaction holds the Session root, as an
    admission does;
  - after a committed drain, admission is refused with `runtime_admission_closed`
    while placement is held, so it took the fast path.
- `ExecutionControlTenantGuardsMySqlIT.admissionBesideDrainAndBindingControlOfTheSameSessionDoesNotDeadlock`:
  40 admissions race binding control of the same binding and a drain of the Session.
  There is no InnoDB deadlock, and every admission after the first refused one is
  refused.
- Existing drain, lifecycle, migration, CSI, Resident Workspace, Runtime broker and lock
  contract suites.

## Risks

- **A plain read before the root lock** would bring the old race back under REPEATABLE
  READ. `lockEntry` is the first statement, and its comment says why.
- **A root created after the pre-read** sends that admission down the guarded path. It
  costs only the old latency.
- **Drain now waits for the Session root,** behind journal commits and lifecycle steps
  of that Session. These are short.
- **Unaudited storage kinds** keep placement. Extending the fast path to them needs the
  same audit for their alias and owner lockers.
