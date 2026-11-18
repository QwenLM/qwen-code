# Resident claim without the tenant guard

[English](2026-11-03-managed-resident-claim-tenant-guard.md) | [简体中文](2026-11-03-managed-resident-claim-tenant-guard.zh-CN.md)

## Problem and current state

The [directory membership design](2026-11-03-managed-workspace-membership-cas.md)
removed the tenant placement guard from LOCAL and SSH_LOCAL `claim` and `release`,
and listed the resident (CSI) branch as a non-goal. That branch still opens a
transaction, takes `WorkspaceStorageKindGuard.lockDomain(tenant)`, and runs
`requireResidentHeld`. Runtime Session acquisition and release on a resident
Workspace therefore wait for any tenant transaction that holds the guard: Runtime
placement, CSI reservation and retirement, migration, maintenance and retention.

`requireResidentHeld` only reads. It checks that the Runtime Session, its binding,
the active slot and the `RESERVED` CSI directory row still match the configured
resident registration, and that no other unreleased Runtime Session exists in the
same binding generation. Neither branch writes a row.

## Goal and scope

Remove the tenant guard from the resident branch of
`WorkspaceExecutionStore.claim` and `release` without changing which requests
succeed. CSI reservation, CSI retirement, resident admission (`requireCreation`)
and other guard holders are out of scope and keep the guard.

## Design

Both resident branches keep their transaction and drop only the guard. The checks
run as nonlocking reads in that transaction, so on MySQL and MariaDB (REPEATABLE
READ) they evaluate one consistent snapshot.

This keeps the possible outcomes because the check writes nothing:

- With the guard, a concurrent transition either commits first, and the check
  sees it, or the check commits first, and the transition proceeds without
  seeing anything from the check.
- Without the guard, a transition committed before the check's snapshot is
  visible, as before. One that commits after the snapshot is ordered after the
  check. That order was already possible with the guard, and the transition
  observes the same state in both cases.

So the change only moves timing within outcomes that already existed. Protection
after acquisition never came from this lock:

- `assertHeld` and `isHeld` already run `requireResidentHeld` without a
  transaction or the guard after acquisition and before release.
- A second Runtime Session in the same binding generation is refused by the
  other-session check. Resident admission (`requireCreation`) and
  `admitSession` keep their own locks.
- CSI reclamation (`verifyClosed`) uses locking reads to require every Runtime
  Session to be `RELEASED` and every tool execution to be settled, so an
  acquiring or live Session blocks it regardless of this guard.

## Affected components

- `WorkspaceExecutionStore`: the resident branches of `claim` and `release`.
- `ResidentWorkspacesTest`: resident claim, refusal of a second Session, and
  release complete while another transaction holds the tenant guard.
- Directory membership design: the resident non-goal points to this document.

There are no schema, API or configuration changes.

## Risks

- A resident `claim` can pass on a snapshot taken just before a transition
  commits. That ordering was already possible, and the post-acquisition
  `assertHeld` check and reclamation's locking reads are unchanged.
- An engine whose default isolation is READ COMMITTED evaluates the queries on
  separate snapshots. Every condition is still checked against committed data;
  the production engines use REPEATABLE READ.

## Verification and acceptance

1. With the tenant guard held by another transaction, resident `claim`,
   `assertHeld` and `release` complete, and a second Session's `claim` is still
   refused.
2. The existing resident suites pass: `ResidentWorkspacesTest`,
   `WorkspaceCsiReservationStoreTest`, `ResidentWorkspaceReuseConcurrencyTest`,
   and the resident retirement and reclamation suites.
3. CI runs their MySQL counterparts.

## Open questions

None.
