# Queue dispatch and Workspace Session creation without the tenant guard

[English](2026-11-04-managed-session-admission-tenant-guard.md) | [简体中文](2026-11-04-managed-session-admission-tenant-guard.zh-CN.md)

## Problem and current state

Turn admission, the Session commands and ordinary journal commits no longer
take the tenant placement guard
([Turn admission](2026-11-03-managed-turn-admission-tenant-guard.md),
[Session commands](2026-11-03-managed-session-commands-tenant-guard.md),
[journal commit](2026-11-03-managed-journal-commit-tenant-guard.md)). Two
admissions that run for ordinary traffic still begin with it:

- `ManagedUserMessageStore.startNext` starts the next queued user message as a
  Turn, once per queued message.
- `AgentSessionAdmissions.insertWorkspaceSessionCommand` creates a Session in
  a Workspace. Its comment requires the transaction's first consistent read to
  follow a lock.

Each therefore queues behind every other guard holder of the tenant.

## Queue dispatch

`startNext` takes the guard, then the Session row (`lock`), reads and updates
the Session's queue rows, and calls the submitter, which runs Turn admission
in the same transaction. Turn admission takes no guard since #16223; it locks
the same Session row and then the storage fence rows. The dispatch to the
Harness runs after commit.

The guard dates from when Turn admission took it, and kept the order guard,
Session row. Without it the first statement is the Session row lock, which
orders the dispatch against lifecycle begin, other queue commands and Turn
admission of the Session. The queue rows are Session-scoped and written only
under that row. Remove the guard.

## Workspace Session creation

A new Session has no row to queue on yet. The creation path reads the
idempotency key with a plain read, then resolves the Workspace with locking
reads of its `ma_workspace` row and the actor's access row, checks the storage
fence (alias and directory rows), and inserts the Session, its stream, its
command receipts and its creation-mode claim. Plain Session creation without a
Workspace already runs this insert path without the guard.

| Role of the guard                                | Replacement                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First consistent read after a lock               | The first statement locks the selected `ma_workspace` row with the predicate `resolveForCreation` uses, so its later lock is the same row.                                                                                                                                                                             |
| Same idempotency key from two requests           | Unchanged: the receipt's unique key decides, the creation-mode claim inserts first and re-reads with a lock, and the service answers a `DuplicateKeyException` with the recorded admission.                                                                                                                            |
| Migration                                        | The storage fence rows are locked before any insert, and migration prepare checks idleness on committed data (#16223). Migration does not lock `ma_workspace`, so there is no reversed order.                                                                                                                          |
| Resident Workspace retirement, Workspace removal | They lock the same `ma_workspace` row, so creations in that Workspace queue behind them.                                                                                                                                                                                                                               |
| Resident Workspace single-Session check          | `ResidentWorkspaces.requireCreation` range-locks the Workspace's open Sessions and its runtime sessions; two adjacent Workspaces' ranges share a gap that both creations insert into. Selections that may resolve to a configured Resident Workspace keep the guard first, decided from configuration before any read. |

The default Workspace was resolved with `tenant_id = ? AND is_default = TRUE`
under `FOR UPDATE`, a scan of the tenant prefix of the
`(tenant_id, workspace_id)` key that locks every Workspace row of the tenant.
Resolution now uses the generated unique column `default_tenant = ?`, which
locks one row.

Team lead creation and child Session creation keep the guard. Child creation
takes it again in `ChildWorkspaceStore.admit` and serializes with the parent's
child run record; both are low frequency.

## Risks

- Creations in one Workspace still queue on its row, and every creation still
  locks the storage's alias row exclusively, so creations sharing one storage
  queue there.
- A missing-key locking read in the creation path that the audit missed would
  show up as an InnoDB deadlock between two creations of one tenant. The MySQL
  test below targets it.
- `mayContain` is conservative: a tenant that configures any Resident
  Workspace keeps the guard for its default-Workspace creations.

## Verification and acceptance

1. `ManagedUserMessageStoreTest`: with the tenant placement guard held on
   another connection, `startNext` claims the queued message and admits its
   Turn.
2. `ManagedModelSelectionTest`: with the guard held, a Workspace Session
   creation completes.
3. `ManagedSessionGuardConvoyIT` (MySQL): four writers create ten Sessions
   each in four Workspaces of one tenant at once, with no deadlock.
4. Existing queue, creation, Workspace, migration and lock contract suites
   pass, including the MySQL profiles in CI.
