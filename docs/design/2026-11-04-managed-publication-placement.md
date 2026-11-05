# Publication lanes without the placement guard

[English](2026-11-04-managed-publication-placement.md) | [简体中文](2026-11-04-managed-publication-placement.zh-CN.md)

Status: proposal (C3 of
[publication lanes without tenant-wide guards](2026-11-04-managed-publication-tenant-guards.md)).
This document replaces the C3 sketch there; its binding-before-root order does
not hold (see "Why not a binding lock in one fixed position").

## Problem

After C1/C2, every step of an ordinary tool publication (reserve, renew,
dispatch, upload, verify, finish, admission, receipt) still begins with the
tenant `runtime_placement` row (`ma_tenant_guard`), in
`ToolPublicationStore.lockPublicationPlacement`, the native branch of
`lockOriginal`, and `JournalWriterLifecycle.lockPublicationWriter`. All
publications of a tenant therefore run one at a time, and behind every
placement owner: binding transitions, provisioning, runtime retention,
migration, storage fences and lifecycle work. Journal commits, Turn admission,
Session commands and ordinary dispatch authorization already run without it.

## What placement protects on these lanes

| Read on the lane                                                      | Writer on the other side                                                                                                                           | Covered without placement by                                                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original binding is `READY` and not drain-requested (`requireAccess`) | Binding transitions (`compareAndSet`, `claimOperation`, `renewOperation`, `releaseOperation`)                                                      | `session` class: they lock the Session root in `lockBindingControl`. `workspace` class: the binding row.                                                                                                  |
| Same                                                                  | Operator recovery (`WorkspaceOperatorRecoveryStore`) moves a `READY` local binding to `OPERATOR_RECOVERY` under placement and the binding row only | Nothing today; C3 routes it through `lockBindingControl` (below).                                                                                                                                         |
| Same                                                                  | `recoverLost`, `releaseLost`, Runtime retention                                                                                                    | Start only from `LOST` or old terminal bindings, which the lane refuses.                                                                                                                                  |
| Execution row (`FOR UPDATE` in `lockOriginal`)                        | Dispatch, recovery, retention                                                                                                                      | The execution row itself; no execution writer takes placement except under binding or slot locks, in binding-then-execution order.                                                                        |
| References stay visible to Runtime retention                          | `JdbcRuntimeRetention.visit` (placement, slot, binding `FOR UPDATE`, reference reads at READ COMMITTED, deletes)                                   | A reservation needs a `READY` binding; retention needs a terminal one older than its window, under the binding lock. Later lanes act on an existing `ma_output_capture` row that the committed read sees. |
| Lifecycle claims and phase (`requireOrdinaryAdmission`)               | Lifecycle begin/complete                                                                                                                           | The head row, as for journal commits (#16256).                                                                                                                                                            |
| Storage fence (`requireSessionStorageOpen`)                           | Migration                                                                                                                                          | Storage rows, as for journal commits and Session commands (#16329).                                                                                                                                       |
| Harness admission rows                                                | Harness drain (`requestHarnessDrain`)                                                                                                              | Only Resident Workspaces read them; they keep placement, as dispatch does.                                                                                                                                |

## Why not a binding lock in one fixed position

Two families of placement owners lock the binding and the Session root in
opposite orders:

- binding, then root: `lockBindingControl` for `session`-class bindings takes
  placement, the publication guard, slot and binding `FOR UPDATE`
  (`readRuntimeRows`), then the root (`readPin`). Every binding transition
  of the default configuration (`isolationClass = session`) goes through it;
- root, then binding: lifecycle verification (`verifyHarnessResources` after
  `WorkspaceLifecycleStore.lock`) and hosted cleanup journal commits
  (`HostedCleanupReferences.apply`, root and head first).

They never meet because both take placement first. A lane without placement
that locks the binding before the root deadlocks with the second family; one
that locks it after the root deadlocks with the first.

## Proposal

An ordinary original is non-CSI and not a Resident Workspace. A publication
lane with an ordinary original drops placement and runs:

1. **Session root first** (`ToolPublicationRetentionStore.lockSessionRoot`),
   where placement was taken. The later root locks in `lockPublicationWriter`
   become re-entrant.
2. **Original binding**, by isolation class:
   - `session` class, with `isolation_key` equal to the publishing Session:
     a READ COMMITTED read of the binding, with no lock. Every transition
     out of `READY` for such a binding holds this root, so the read sees
     every committed one, and any later one waits for this transaction.
   - `workspace` class: `FOR SHARE` on the binding after the root. Its writers
     take no root (`lockBindingControl` returns at once). The root-then-binding
     owners lock the root first. Publications of different Sessions on one
     binding share it.
3. **Execution `FOR UPDATE`**, then head and publication rows as in C2.

Placement stays, first as today, for CSI originals, Resident Workspace
originals, a session-class binding whose isolation key is a different
Session, receipts with lifecycle authority (`checkLifecycleWriter` takes it),
and receipts whose journal commit carries hosted cleanup (`JournalCommit`
takes it).

Operator recovery locks the binding through `lockBindingControl`, the order
`compareAndSet` uses (placement, guard, slot, binding, root). Then every
transition out of `READY` for a session-class binding holds the root.

Publication transactions already run at READ COMMITTED (C1). Their plain
reads before the root (`findPublicationRow`, the binding identity) only read
immutable identity, as today.

## Open questions

1. The `isolation_key` of a session-class original equals the publishing
   Session in every flow found. The lane checks it and keeps placement when
   it does not hold.
2. The native snapshot writer (C2 note) also takes placement; it is out of
   scope here.

## Risks

- A missed writer that leaves `READY` without the root lets a lane publish
  against a binding that has just stopped. The table above is the inventory,
  and the MySQL audit holds each writer's row while a lane runs.
- `FOR SHARE` on a shared binding followed by a `FOR UPDATE` in the same
  transaction would deadlock two lanes. Lanes never write the binding; the
  receipt case that could (hosted cleanup) keeps placement.

## Verification and acceptance

- Convoy audit: with placement held on another connection, every ordinary
  lane completes within the bound; CSI, Resident Workspace, lifecycle
  authority and cleanup receipts still fail fast.
- MySQL: lanes against a binding transition (`compareAndSet` to `DRAINING`),
  lifecycle verification, operator recovery and a hosted cleanup commit, run
  concurrently on one Session and on one shared binding, end with no deadlock,
  and a lane after a transition refuses the binding.
- MySQL: Runtime retention against concurrent reservations never deletes a
  referenced execution or binding.
- Existing publication, retention, lifecycle, CSI and lock contract suites
  pass, including the MySQL profiles in CI.
