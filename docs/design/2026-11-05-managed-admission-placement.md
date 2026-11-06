# Tool execution admission without tenant placement

[English](2026-11-05-managed-admission-placement.md) | [简体中文](2026-11-05-managed-admission-placement.zh-CN.md)

Status: proposal. This is part (b) of
[2026-11-05-managed-dispatch-tenant-guards](2026-11-05-managed-dispatch-tenant-guards.md).

## Problem

After part (a), dispatch of an ordinary session-class binding takes no tenant guard,
and admission takes no publication guard. `JdbcRuntimeBindingRepository.admitExecution`
still takes tenant `runtime_placement` first, unconditionally. Every tool call of a
tenant therefore still queues once on the tenant placement row, behind binding
transitions, provisioning, retention, maintenance, collectors and writer acquisition.

## What placement orders for admission

Admission reads several fences with plain reads. Placement made each read ordered
against the writer of that fence:

| Fence                                | Writer and its locks                                                                           | What admission does                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Harness drain (`DRAINING`)           | `requestHarnessDrain`: placement only                                                          | plain read of the `ma_session_head` row      |
| Lifecycle begin (`LIFECYCLE_ONLY`)   | `beginLifecycle` → `beginHarnessLifecycle`: the Session root (`requireLegacySessionForUpdate`) | same read                                    |
| Lifecycle effects (`DRAINING`)       | `WorkspaceLifecycleStore.saveLocked`: placement, publication guard, Session root               | same read                                    |
| Storage fence (`fence_operation_id`) | `requestStorageFence` (placement), Workspace migration (migration authority)                   | plain read of `ma_storage`                   |
| Local physical storage owner         | storage registration, migration and the CSI paths                                              | `ma_storage_owner FOR UPDATE`, after binding |

Every other row admission touches is a row lock: the Session root (part (a)), the
binding, the Runtime Session and the new execution.

- **Lifecycle phases already hold the Session root.** Since part (a), admission of an
  ordinary binding holds that root through commit, so it is ordered against them
  without placement.
- **The storage fence has a backstop.** Migration's `assertRetired` requires every
  binding of the storage `RELEASED` and no unsettled execution. A binding leaves
  `READY` under its row lock, which admission holds, so an execution admitted beside a
  new fence blocks the migration as `migration_work_unsettled`. It never slips past.
- **The harness drain fence is the gap.** `requestHarnessDrain` takes no row that
  admission takes. `drainHarnessSession` and `verifyHarnessStopped` do check executions
  afterwards, but the fence is meant to stop new work before the drain starts.
- **Local physical storage owners are not audited.** Admission locks
  `ma_storage_owner` after the binding. The order other owners use for these two rows
  is not established yet.

## Proposal

1. **Drain takes the Session root.** `requestHarnessDrain` locks the Session root
   (`ma_session ... FOR UPDATE`) after placement and before it writes the head row.
   Placement → root is the order every placement owner already uses. The callers
   (`ManagedRuntimeCoordinator.requestWorkspaceClose`, through
   `SessionLifecycleCoordinator`) run it in its own transaction, outside any database
   transaction. A harness Session without a root keeps today's behavior.
2. **Placement-free admission.** Before the transaction, next to the existing
   `findById`, plain reads on their own connection decide whether admission may skip
   placement. They require all of these:
   - the binding is outside the CSI files profile and not a Resident Workspace;
   - `isolationClass = session`, and it does not share Runtime Sessions;
   - no lifecycle authority (such a check already share-locks the head row);
   - the Session root of the isolation key exists;
   - the binding's storage has no local physical owner.

   Otherwise admission takes placement first, as today.

3. **No consistent read before the root.** Under REPEATABLE READ, the first plain read
   of a transaction fixes its snapshot. Today the first read follows placement. On the
   fast path, the first statement is the root lock: `lockExecutionControl` receives the
   pre-read root existence instead of reading it inside the transaction. Every later
   plain read, the head row included, then sees all commits made before the root was
   granted.

### Why this is enough

- **Drain commits first.** It held the root until it committed. Admission's root lock
  is granted after that, and its head read sees `DRAINING`, so admission refuses.
- **Admission commits first.** Drain waits for the root until admission commits. The
  execution is then durable before `DRAINING`, exactly like an execution admitted just
  before the fence today. The later drain steps settle it, and `verifyHarnessStopped`
  locks the bindings and checks executions as before.
- **Lifecycle phases** are ordered by the same root, as shown above.

### Resulting orders

| Path                    | Order                                                                      |
| ----------------------- | -------------------------------------------------------------------------- |
| Admission (fast path)   | root → binding → Runtime Session → execution                               |
| Admission (otherwise)   | placement → (storage) → root → binding → (storage owner) → Runtime Session |
| Dispatch (non-Resident) | root → binding → Runtime Session → execution                               |
| `requestHarnessDrain`   | placement → root → head                                                    |
| `verifyHarnessStopped`  | placement → head → bindings → Runtime Sessions (behind the lifecycle root) |
| Runtime retention       | placement → slot → binding → executions → Runtime Sessions                 |

Admission keeps the binding before the Runtime Session and the execution, like
retention and dispatch. It takes the root first, and no guard-free path locks a binding
and then a root.

## Verification plan

- `ExecutionControlTenantGuardsTest` (H2) and its MySQL subclass:
  - fast-path admission completes while placement and the publication guard are held;
  - admission keeps waiting for placement without a root, with a local physical storage
    owner, and for a binding that shares Runtime Sessions.
- Drain ordering, made deterministic with a statement hook:
  - admission is paused after its root lock, `requestHarnessDrain` waits, and the drain
    then sees the committed execution;
  - after a committed drain, admission refuses with `runtime_admission_closed`.
- MySQL stress: admissions race `requestHarnessDrain`, binding control and dispatch of
  the same Session, with no InnoDB deadlock.
- Existing drain, lifecycle, migration, CSI, Resident Workspace and lock contract suites.

## Risks

- **A plain read before the root lock** would bring the old race back under REPEATABLE
  READ. The verification hook pins the statement order, and the code says why.
- **A root created after the pre-read** sends that admission down the guarded path. It
  costs only the old latency.
- **A root deleted after the pre-read** is refused, as in part (a).
- **Drain now waits for the Session root,** behind journal commits and lifecycle steps
  of that Session. These are short and already order before the drain in practice.
