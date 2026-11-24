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
| Migration                                        | The storage fence rows are locked before any insert. After locking the alias, migration checks committed work and the complete Session profile inventory on a fresh connection. Migration does not lock `ma_workspace`, so there is no reversed order.                                                                 |
| Resident Workspace retirement, Workspace removal | They lock the same `ma_workspace` row, so creations in that Workspace queue behind them.                                                                                                                                                                                                                               |
| Resident Workspace single-Session check          | `ResidentWorkspaces.requireCreation` range-locks the Workspace's open Sessions and its runtime sessions; two adjacent Workspaces' ranges share a gap that both creations insert into. Selections that may resolve to a configured Resident Workspace keep the guard first, decided from configuration before any read. |

Default Workspace resolution retains `tenant_id = ? AND is_default = TRUE`
under `FOR UPDATE`, a scan of the tenant prefix of the
`(tenant_id, workspace_id)` key that can lock other Workspace rows of the
tenant. The proposed `default_tenant = ?` lookup deadlocks on MySQL 8.4 when
an administrator first updates Workspace metadata and then switches the
default: the reader holds the generated unique index and waits for the row,
while the administrator holds the row and waits for that index. Keep the
existing lookup order; narrowing default-selection locks needs a separate
design that preserves concurrent default-switch behavior.

Team lead creation and child Session creation keep the guard. Child creation
takes it again in `ChildWorkspaceStore.admit` and serializes with the parent's
child run record; both are low frequency.

The first Workspace locking read is owned by `ManagedWorkspaceRegistry`,
which keeps its selection predicate and arguments private. Session admission
retains the Resident Workspace guard decision and its lock-order explanation.
For this change, an explicitly approved per-class ceiling adjustment from
889 to 900 lines accommodates that necessary logic and explanation. This is
a scoped exception to the ratchet-down convention; the global ceiling and
the other per-class ceilings remain unchanged.

Migration can establish a REPEATABLE READ snapshot before waiting for a
creation's storage alias lock. Its existing fresh autocommit idle check must
also validate the complete Session profile inventory, including Sessions
committed during that wait. Otherwise it can miss an uninitialized or
unsupported Session. Read the inventory, receipts, genesis and definition
resources through that same fresh connection. The outer transaction holds the
alias and publication authority locks; the fresh reader must not lock Session
or head rows and reverse ordinary traffic's Session-before-alias order.

## Risks

- Creations in one Workspace still queue on its row, and every creation still
  locks the storage's alias row exclusively, so creations sharing one storage
  queue there. Default selection retains the tenant-prefix scan and can also
  delay creations in other Workspaces of the tenant.
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
   each in one tenant at once, with no deadlock. Cover explicit selections
   across four Workspaces and selection of the default Workspace, each with
   separate storage registrations and with shared storage. Default selections
   must bind every Session to the default Workspace. The existing MySQL
   default-switch test must resolve the newly selected default without a deadlock.
4. `WorkspaceMigrationMySqlIT`: creation and legacy CWD settlement wait on an
   uncommitted `ma_storage` fence, reject it after commit, preserve original
   request replay and allow the unrelated tenant to progress. A Session
   committed after migration's REPEATABLE READ snapshot must still be checked:
   an uninitialized Session rejects migration without leaving an operation or
   fence.
5. Existing queue, creation, Workspace, migration and lock contract suites
   pass, including the MySQL profiles in CI.
6. The source-size gate accepts the 900-line admission class at its exact
   approved ceiling and preserves main's 4,253-line broker and global ceilings.
