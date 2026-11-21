# Journal commit without the tenant guard

[English](2026-11-03-managed-journal-commit-tenant-guard.md) | [简体中文](2026-11-03-managed-journal-commit-tenant-guard.zh-CN.md)

The storage-lock ordering below is superseded for ordinary journal commits and inline/publication results by the [2026-11-05 design](2026-11-05-managed-publication-storage-sharing.md). Those paths use nonlocking physical-state checks under the existing offline-maintenance contract; other admission and lifecycle locks remain as described.

## Problem and current state

`JournalCommit.commit` is the hottest write path in a Managed Session. Every
batch of Harness journal records goes through it. Its first database statement
is the tenant placement guard (`WorkspaceLifecycleStore.lockPlacement`, bounded
by `GUARD_ACQUIRE_TIMEOUT_SECONDS`), and the guard is held until the commit
transaction ends. While held, it covers record parsing, resource writes,
extension and action projection, and the head update. So every journal commit
of every Session in a tenant runs one at a time, and also queues behind
Runtime placement, storage work, migration, maintenance and retention. Under
load it answers `tenant_guard_contended` once the bound expires.

`requirePhysicalSessionOpen` takes the guard a second time (re-entrant today)
before it locks the storage's alias and directory rows.

The [Turn admission](2026-11-03-managed-turn-admission-tenant-guard.md) and
[Session command](2026-11-03-managed-session-commands-tenant-guard.md)
designs removed the guard from paths with no tenant-wide reason for it. The
code comment explains why commit still holds it: "a begin/lifecycle admission
serializes with only that row, so without it an admission sails through
mid-commit."

## What the guard does for a commit

| Role                                      | Who relies on it                                                                                              | Today                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| R1. Order against lifecycle               | Lifecycle begin (v1/v2 claim insert), lifecycle settle and verification, Harness takeover and quiesce         | They take the guard, then the Session row (`ma_session`), then the head row. A commit holding the guard cannot interleave with them. |
| R2. Keep guard-holding readers consistent | Migration prepare; Runtime retention sweep (`JdbcRuntimeRetention.visit`, READ COMMITTED); Session retirement | They read rows that a commit writes while holding the guard.                                                                         |
| R3. Serialize all commits of a tenant     | Nobody on purpose                                                                                             | It hides two hazards inside the commit path: locking reads on missing keys followed by inserts, and cross-Session locks.             |

## Design

The commit queues on its own **Session row** instead of the tenant row. An
earlier note said "the Session head row". The Session row is the right
choice, because every R1 participant locks `ma_session` before the head.
Taking the head first would invert that order.

1. **Session row first.** Delete the guard at the top of `commit` (ordinary
   commits, `authority == null`). Its first statement becomes
   `ToolPublicationRetentionStore.lockSessionRoot`: insert-or-update by primary
   key `(tenant_id, session_id)`, then `FOR UPDATE`. The commit already makes
   this call later through `lockCsiContinuation`. A primary-key duplicate takes
   a record lock and no gap lock. `requirePlacement` then locks the same row
   again, which is free. The credential check and `validateCommit` make no
   database calls, so the transaction's first consistent read comes after the
   Session lock.
2. **Fence check without the guard, after the Session row.** The commit
   checks the storage fence with `requireSessionStorageOpen`: the locking
   reads of the alias and directory rows, without the guard. This is the Turn
   admission argument: migration prepare locks those rows and then checks
   idleness on committed data (#16223). The two publication lanes
   (`lockPublicationWriter`, `publishToolResult`) still take the placement
   guard, but now check the fence after their Session row and before the head,
   instead of before the Session row. Every lane then locks Session row,
   storage rows, head in that order. The old publication order (storage rows,
   then Session row) closed a cycle with any guard-free lane on the same
   Session (Turn admission since #16223, the Session commands, and now
   commits), which the guard used to prevent.
3. **Missing-key locking reads become probe, insert and duplicate
   re-read.** With commits of different Sessions running at once, a
   `FOR UPDATE` on a key that does not exist takes a gap lock. Two Sessions
   whose new keys fall into the same gap then deadlock on insert. Every key in
   question is prefixed by its Session scope key, but the gap between two
   Sessions' keys is shared. Each such site switches to: plain read, insert if
   absent, and on `DuplicateKeyException` a locking re-read and the existing
   identity check. This is the pattern #16225 uses for receipts. A sweep of
   every `FOR UPDATE` reachable from `commit` found two such sites:

   | Site                                                     | Row                                      | Missing when             |
   | -------------------------------------------------------- | ---------------------------------------- | ------------------------ |
   | `JournalResourceWrites.commitResources` → `findResource` | `ma_resource (scope_key, resource_id)`   | Every new resource       |
   | `HostedCleanupReferences.apply`                          | `ma_resource_ref` `HOSTED_CLEANUP` owner | First state of a cleanup |

   The other locking reads hit rows that always exist (the Session row, the
   head row, a referenced resource whose absence fails the commit), or serve a
   deliberate seam. `reconcileNeverStartedVerdict` locks a child run record and
   the parent's child lineage, so a never-started verdict serializes with child
   Session creation. A commit never inserts into the lineage index. The run
   record exists unless it is first written in the same commit as its verdict;
   that rare case keeps a gap lock, and a deadlock there is rolled back like
   any other.

4. **Unchanged paths.** Lifecycle-authority commits (`authority != null`)
   still take both guards in `checkLifecycleWriter`, before anything else.
   CSI-pinned Sessions still take both guards in `lockCsiContinuation`, after
   their root. That order is root → guard, the one renew and recovery already
   use. Deadlocks with guard-first paths are mapped to
   `tenant_guard_contended` by `lockBounded` and `namedRootDeadlock`.

## Why the guard's readers stay correct

| Reader                                                             | Why it does not need the commit to hold the guard                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lifecycle begin                                                    | It locks the Session row before writing the `CLOSE`/`ARCHIVE`/`DELETE` operation (the v2 claim). A commit holds that row from its first statement. Begin runs either before the commit's snapshot (the commit's `requireNoLifecycleClaim` sees the claim) or after the commit ends (`requireIdleJournal` locks the head and rescans with a locking read when its snapshot is behind; #13800 R2-3).                                                               |
| Lifecycle settle and verification (`WorkspaceLifecycleStore.lock`) | Guard, then the Session row `FOR UPDATE`. Same argument.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Harness takeover and quiesce                                       | They lock the Session row (`HarnessPlacementStore.lock`), and the commit's `requirePlacement` locks it too.                                                                                                                                                                                                                                                                                                                                                      |
| Migration prepare                                                  | Alias and directory rows plus the committed-read idle check (#16223). The commit locks those rows before it writes anything. The idle check's live-writer count reads writer leases, which a commit does not change.                                                                                                                                                                                                                                             |
| Runtime retention sweep                                            | It only reads rows a commit writes (hosted cleanup references, `cleanup_head_revision`, `child_run` records, `ma_output_capture`). It only deletes rows a commit never reads (`ma_runtime_binding`, `ma_runtime_session`, `ma_tool_execution`). So every interleaving gives the same result as running the sweep first and the commit after, an order the guard already allows. `hasCsiRuntimeMarker` reads bindings, but the sweep never deletes a CSI binding. |
| Session retirement                                                 | It locks the head row `FOR UPDATE` before it reads or deletes journal rows. The commit holds that row.                                                                                                                                                                                                                                                                                                                                                           |
| Writer acquire, renew and release                                  | They lock the head row, and the commit's writer check reads it under its own lock.                                                                                                                                                                                                                                                                                                                                                                               |

## Rejected alternatives

- **Head row first.** Lifecycle begin, settle and Harness placement lock
  `ma_session` before `ma_session_head`. A commit that locked the head first
  and the Session row later (`requirePlacement`) would deadlock against them.
- **Keep the guard only for some record kinds.** Hosted cleanup and resource
  writes are common, so too many commits would keep the guard. The
  read-and-delete argument above makes the condition unnecessary.

## Risks

- The fence check locks the storage's alias and directory rows exclusively,
  so commits of Sessions that share one workspace storage still run one at a
  time on the alias row. The gain is across storages, not within one. Taking
  those rows `FOR SHARE` (migration and the fence writers still lock them
  exclusively) would remove that queue for commits, Turn admission and
  Session commands alike; it is left as a follow-up because it changes the
  merged lanes too.
- One Session's commits still run one at a time on its Session row, which
  they already did through the head row. A Session command (rename, model
  change) and a commit of the same Session now wait on each other, not on the
  tenant.
- CSI-pinned commits now meet the guard after their root rather than before.
  Same-Session deadlocks against guard-first lanes may become more frequent.
  They are named and retried as today.
- The commit-path audit is static. A missed missing-key locking read shows up
  as an InnoDB deadlock (1213) between two Sessions of one tenant. The victim
  is rolled back, and a retry of the same command is idempotent by command
  key. The MySQL test below targets it.
- Pre-existing and unchanged: the sweep can retire a binding before a commit
  records a hosted cleanup reference to it, an order the guard already allows.
  Follow-up: the reference insert should lock the binding row `FOR SHARE` and
  refuse when it is gone.

## Verification and acceptance

1. While another transaction holds the tenant placement guard, an ordinary
   commit completes. `ManagedSessionGuardConvoyIT` asserts commit is not
   guard-bound.
2. Ordering on the Session row. A duplicate commit parked behind an
   uncommitted winner waits on the Session row, not the tenant guard, and
   replays the winner once it commits. This shows that the plain lookups after
   the lock read a snapshot taken after it
   (`duplicateCommitReplaysOnceTheWinnerReleasesItsGuards`). A deletion
   admission started behind a blocked record commit waits on that commit's
   Session row and completes after it
   (`ManagedAgentMySqlIT.serializesDeletionBehindTheRecordCommit`).
3. MySQL only: four writers open Sessions of one tenant and commit the monitor
   chain fixtures in parallel. Every revision publishes a new resource, and all
   of them complete without a deadlock (`concurrentCommitsOfOneTenantDoNotDeadlock`).
   H2 does not take gap locks, so this needs the MySQL profile. Hosted cleanup
   references are covered by the existing hosted cleanup suites only.
4. Existing journal, lifecycle, Harness placement, migration, retention, CSI
   and hosted recovery suites pass, including the MySQL profiles in CI.

## Delivery

One PR stacked on #16223. Commit 1 converts the two missing-key sites
(step 3); it is safe with the guard still in place. Commit 2 removes the guard
and adds the guard-free fence check variant (steps 1 and 2), with tests 1
to 3.
